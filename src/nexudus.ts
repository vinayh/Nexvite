/**
 * Nexudus API client: the Durable Object-backed auth chain and the three
 * operations the app performs — create visitors, resolve their Ids from the
 * account's own list, delete by Id. Returns data and outcome counts only;
 * member-facing wording lives with the flows in src/index.ts.
 *
 * Never log tokens, visitor fields, or Nexudus response bodies; HTTP statuses
 * and error codes are safe to log (see the PII rules in src/index.ts).
 */

// ---------------------------------------------------------------------------
// Nexudus auth (Durable Object-backed, auto-refreshing)
// ---------------------------------------------------------------------------
//
// Nexudus refresh tokens are single-use and rotate on every exchange. One
// Durable Object serializes refreshes and persists the current pair. The
// Worker secret is only a bootstrap/reset seed; a higher seed_version replaces
// the stored chain, while older deployed versions cannot roll it back.

import type { NexudusAuthCoordinator } from "./nexudus-auth";

function authCoordinator(env: Env): DurableObjectStub<NexudusAuthCoordinator> {
	return env.NEXUDUS_AUTH.getByName(env.NEXUDUS_SUBDOMAIN);
}

// Contact address for member-facing failure messages: the Nexudus account
// email from the auth record (registrations live under the service account,
// so members can't see them in their own portal login), or a generic fallback
// when auth storage is unavailable.
export async function nexudusContact(env: Env): Promise<string> {
	try {
		return (await authCoordinator(env).getAuth(env.NEXUDUS_AUTH_SEED))?.username ?? "the space team";
	} catch {
		return "the space team";
	}
}

function nexudusBase(env: Env): string {
	return `https://${env.NEXUDUS_SUBDOMAIN}.spaces.nexudus.com`;
}

// Run an authenticated Nexudus API request: current token first; on a 401
// refresh once (rotating the Durable Object record) and retry. A 401 that survives the
// refresh is a broken auth chain, not a caller-level rejection, so it also
// yields null. Never throws; returns null on an auth or network failure,
// which the caller turns into a member-facing message.
async function nexudusFetch(
	env: Env,
	path: string,
	init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response | null> {
	const base = nexudusBase(env);
	const doFetch = (accessToken: string) =>
		fetch(`${base}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${accessToken}` } });
	try {
		const coordinator = authCoordinator(env);
		const auth = await coordinator.getAuth(env.NEXUDUS_AUTH_SEED);
		if (!auth) {
			console.error("nexudus auth seed missing or invalid; run scripts/nexudus-token.sh | scripts/nexudus-seed.sh");
			return null;
		}
		let res = await doFetch(auth.access_token);
		if (res.status === 401) {
			const refreshed = await coordinator.refresh(env.NEXUDUS_AUTH_SEED, base, auth.access_token);
			if (!refreshed) {
				console.error("nexudus token refresh failed; re-seed with scripts/nexudus-token.sh | scripts/nexudus-seed.sh");
				return null;
			}
			res = await doFetch(refreshed.access_token);
			if (res.status === 401) {
				console.error("nexudus rejected the refreshed token; check the account, then re-seed with scripts/nexudus-token.sh | scripts/nexudus-seed.sh");
				return null;
			}
		}
		return res;
	} catch (err) {
		console.error(`nexudus request threw: ${err instanceof Error ? err.name : "unknown"}`); // no PII
		return null;
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Visitor operations
// ---------------------------------------------------------------------------

// One visitor object per visit; BusinessId is stamped on here from config
// (only ever from config, never from the request).
export interface NewVisitor {
	FullName: string;
	Email: string;
	PhoneNumber?: string;
	ExpectedArrival: string; // naive UTC wall-clock, "YYYY-MM-DDTHH:mm:ss"
	CustomerNotes: string;
}

// POST the whole series in a single create request: this is how the Nexudus
// API registers a repeating series — there is no recurrence field (AGENTS).
// Null on an auth or network failure (see nexudusFetch).
export function createVisitors(env: Env, visitors: NewVisitor[]): Promise<Response | null> {
	// BusinessId is stamped last so config always wins, whatever the caller passed.
	const body = JSON.stringify(visitors.map((visitor) => ({ ...visitor, BusinessId: Number(env.NEXUDUS_BUSINESS_ID) })));
	return nexudusFetch(env, "/api/public/visitors", { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

// Parse a Nexudus date value to epoch milliseconds. Tolerates ISO strings
// (naive ones are treated as UTC, matching what we send) and the legacy
// "/Date(ms)/" form. Returns null for anything unparseable.
function parseNexudusInstant(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const legacy = /^\/Date\((-?\d+)/.exec(value);
	if (legacy) return Number(legacy[1]);
	const iso = /[Zz]$|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}

// /my returns a paged { Records: [...] } envelope.
function listRecords(body: unknown): unknown[] {
	if (body && typeof body === "object") {
		const obj = body as Record<string, unknown>;
		if (Array.isArray(obj.Records)) return obj.Records;
	}
	return [];
}

interface VisitorRecord {
	Id: number;
	Email: string;
	ExpectedArrival?: unknown;
	UtcExpectedArrival?: unknown;
}

// Delay before the single lookup retry; mutable so tests can shrink it.
export const lookupRetry = { ms: 1000 };

// /my is paginated: 15 records per page by default, which a series alone can
// exceed (the cap is 30), so ask for a large page and follow HasNextPage.
// `size` and `page` are the params it honors; orderBy/dir are ignored, so the
// order is always ExpectedArrival ascending and a new series can sit on any
// page. maxPages bounds the request count against the 10 req / 5 s limit.
export const lookupPaging = { size: 100, maxPages: 5 };

// True only for a paged envelope that says another page follows.
function hasNextPage(body: unknown): boolean {
	return !!body && typeof body === "object" && !Array.isArray(body) && (body as { HasNextPage?: unknown }).HasNextPage === true;
}

// Resolve the new registrations' Ids from the account's own list (the only
// read route, see AGENTS), matching on email + each exact visit instant,
// newest wins per instant among the records read. Walks pages until every
// visit resolves, so a long series can't fall off page 1. Retries once for
// replication lag; null unless every visit resolves (a partial series takes
// the soft-unconfirmed path rather than claiming success).
export async function lookupVisitorIds(env: Env, email: string, arrivalUtcs: string[]): Promise<number[] | null> {
	const sentMs = arrivalUtcs.map((arrivalUtc) => Date.parse(`${arrivalUtc}Z`));
	// UtcExpectedArrival wins whenever it parses: ExpectedArrival can be
	// space-local, so a visit one offset-hour away could match by coincidence.
	const matchIds = (records: VisitorRecord[]): number[] | null => {
		const ids = sentMs.map((ms) => {
			const matches = records.filter(
				(r) => (parseNexudusInstant(r.UtcExpectedArrival) ?? parseNexudusInstant(r.ExpectedArrival)) === ms,
			);
			return matches.length ? matches.reduce((a, b) => (b.Id > a.Id ? b : a)).Id : null;
		});
		return ids.every((id): id is number => id != null) ? ids : null;
	};
	const attempt = async (): Promise<number[] | null> => {
		const mine: VisitorRecord[] = [];
		for (let page = 1; page <= lookupPaging.maxPages; page++) {
			const res = await nexudusFetch(env, `/api/public/visitors/my?showUpcoming=true&size=${lookupPaging.size}&page=${page}`);
			if (!res?.ok) return null;
			const body = (await res.json().catch(() => null)) as unknown;
			mine.push(
				...listRecords(body).filter(
					(r): r is VisitorRecord =>
						typeof (r as { Id?: unknown })?.Id === "number" &&
						typeof (r as { Email?: unknown })?.Email === "string" &&
						(r as { Email: string }).Email.toLowerCase() === email.toLowerCase(),
				),
			);
			const ids = matchIds(mine);
			if (ids != null) return ids;
			if (!hasNextPage(body)) return null;
		}
		console.warn(`visitor Id lookup gave up after ${lookupPaging.maxPages} pages`); // no PII
		return null;
	};
	const ids = await attempt();
	if (ids != null) return ids;
	await sleep(lookupRetry.ms);
	return attempt();
}

// One account-wide deletion slot every 750 ms: at most seven ordinary DELETEs
// land in a rolling five-second window, leaving room for a 401, refresh, and
// retry under Nexudus' 10 requests / 5 s limit. Mutable so tests can zero it.
export const deletePacing = { ms: 750 };

// Delete registrations by Id (captured at registration, so no lookup and no
// duplicate ambiguity) and count what didn't go: `missing` visits were already
// gone (404/410), `failed` ones errored. Never throws. Deletes run in
// sequence, with every call reserving a slot from the account's Durable Object
// so concurrent delete flows cannot collectively exceed the API limit.
export async function deleteVisitorIds(env: Env, ids: number[]): Promise<{ missing: number; failed: number }> {
	let missing = 0;
	let failed = 0;
	const coordinator = authCoordinator(env);
	for (let i = 0; i < ids.length; i++) {
		try {
			const wait = await coordinator.reserveDeletion(deletePacing.ms);
			if (wait > 0) await sleep(wait);
		} catch (err) {
			console.error(`nexudus deletion pacing threw: ${err instanceof Error ? err.name : "unknown"}`);
			failed += ids.length - i;
			break;
		}
		const res = await nexudusFetch(env, `/api/public/visitors/${ids[i]}`, { method: "DELETE" });
		if (res?.ok) continue;
		if (res && (res.status === 404 || res.status === 410)) missing++;
		else {
			if (res) console.warn(`visitor delete failed: HTTP ${res.status}`); // status only, no PII
			failed++;
		}
	}
	return { missing, failed };
}
