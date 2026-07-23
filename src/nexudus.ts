/**
 * Nexudus API client: the KV-backed auto-refreshing auth chain and the three
 * operations the app performs — create visitors, resolve their Ids from the
 * account's own list, delete by Id. Returns data and outcome counts only;
 * member-facing wording lives with the flows in src/index.ts.
 *
 * Never log tokens, visitor fields, or Nexudus response bodies; HTTP statuses
 * and error codes are safe to log (see the PII rules in src/index.ts).
 */

// ---------------------------------------------------------------------------
// Nexudus auth (KV-backed, auto-refreshing)
// ---------------------------------------------------------------------------
//
// Nexudus refresh tokens are single-use and rotate on every exchange, so the
// live auth record lives in KV (env.TOKENS), shared with the Nexroom Worker,
// which binds the same namespace. There is no other credential source: seed
// (or re-seed after a broken chain) with
// scripts/nexudus-token.sh | scripts/nexudus-seed.sh.

export const TOKEN_KEY = "nexudus"; // exported for the tests

interface NexudusAuth {
	username: string; // account email, sent as the client_id header on refresh
	access_token: string;
	refresh_token: string;
}

// Read the live auth record. Returns null when the KV key is missing or
// malformed (including a legacy pair without `username`), which means
// unseeded; there is no fallback credential source.
async function readAuth(env: Env): Promise<NexudusAuth | null> {
	const raw = await env.TOKENS.get(TOKEN_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<NexudusAuth>;
		if (typeof parsed.username === "string" && typeof parsed.access_token === "string" && typeof parsed.refresh_token === "string") {
			return { username: parsed.username, access_token: parsed.access_token, refresh_token: parsed.refresh_token };
		}
	} catch {
		// malformed, treat as unseeded
	}
	return null;
}

// Contact address for member-facing failure messages: the Nexudus account
// email from the KV auth record (registrations live under the service account,
// so members can't see them in their own portal login), or a generic fallback
// when KV itself is unavailable.
export async function nexudusContact(env: Env): Promise<string> {
	try {
		return (await readAuth(env))?.username ?? "the space team";
	} catch {
		return "the space team";
	}
}

// Exchange the single-use refresh token for a fresh pair. client_id is the
// account email, sent as a header (Nexudus requirement). Returns null on any
// failure; the caller surfaces a re-seed message.
async function refreshAuth(base: string, auth: NexudusAuth): Promise<NexudusAuth | null> {
	const res = await fetch(`${base}/api/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			client_id: auth.username,
		},
		body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refresh_token }),
	});
	if (!res.ok) return null;
	const body = (await res.json().catch(() => null)) as Partial<NexudusAuth> | null;
	if (typeof body?.access_token !== "string" || typeof body?.refresh_token !== "string") return null;
	return { username: auth.username, access_token: body.access_token, refresh_token: body.refresh_token };
}

function nexudusBase(env: Env): string {
	return `https://${env.NEXUDUS_SUBDOMAIN}.spaces.nexudus.com`;
}

// Run an authenticated Nexudus request: current token first; on a 401 refresh
// once (rotating the KV record) and retry. A 401 that survives the refresh is
// a broken auth chain, not a caller-level rejection, so it also yields null.
// Never throws; returns null on an auth or network failure, which the caller
// turns into a member-facing message.
async function nexudusFetch(env: Env, doFetch: (base: string, accessToken: string) => Promise<Response>): Promise<Response | null> {
	const base = nexudusBase(env);
	try {
		const auth = await readAuth(env);
		if (!auth) {
			console.error("nexudus auth missing from KV; seed with scripts/nexudus-token.sh | scripts/nexudus-seed.sh");
			return null;
		}
		let res = await doFetch(base, auth.access_token);
		if (res.status === 401) {
			const refreshed = await refreshAuth(base, auth);
			if (!refreshed) {
				console.error("nexudus token refresh failed; re-seed with scripts/nexudus-token.sh | scripts/nexudus-seed.sh");
				return null;
			}
			await env.TOKENS.put(TOKEN_KEY, JSON.stringify(refreshed));
			res = await doFetch(base, refreshed.access_token);
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
// API registers a repeating series — there is no recurrence field (README).
// Null on an auth or network failure (see nexudusFetch).
export function createVisitors(env: Env, visitors: NewVisitor[]): Promise<Response | null> {
	const body = JSON.stringify(visitors.map((visitor) => ({ BusinessId: Number(env.NEXUDUS_BUSINESS_ID), ...visitor })));
	return nexudusFetch(env, (base, accessToken) =>
		fetch(`${base}/api/public/visitors`, {
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
			body,
		}),
	);
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

// The list body may be a bare array or an envelope; { Records: [...] } is the
// Nexudus norm, but tolerate any single array-valued property.
function listRecords(body: unknown): unknown[] {
	if (Array.isArray(body)) return body;
	if (body && typeof body === "object") {
		const obj = body as Record<string, unknown>;
		if (Array.isArray(obj.Records)) return obj.Records;
		for (const value of Object.values(obj)) if (Array.isArray(value)) return value;
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

// Resolve the new registrations' Ids from the account's own list (the only
// read route, see README), matching on email + each exact visit instant,
// newest wins per instant. One GET covers the whole series. Retries once for
// replication lag; null unless every visit resolves (a partial series takes
// the soft-unconfirmed path rather than claiming success).
export async function lookupVisitorIds(env: Env, email: string, arrivalUtcs: string[]): Promise<number[] | null> {
	const sentMs = arrivalUtcs.map((arrivalUtc) => Date.parse(`${arrivalUtc}Z`));
	const attempt = async (): Promise<number[] | null> => {
		const res = await nexudusFetch(env, (base, accessToken) =>
			fetch(`${base}/api/public/visitors/my?showUpcoming=true`, {
				headers: { Authorization: `Bearer ${accessToken}` },
			}),
		);
		if (!res?.ok) return null;
		// UtcExpectedArrival wins whenever it parses: ExpectedArrival can be
		// space-local, so a visit one offset-hour away could match by coincidence.
		const records = listRecords(await res.json().catch(() => null)).filter(
			(r): r is VisitorRecord =>
				typeof (r as { Id?: unknown })?.Id === "number" &&
				typeof (r as { Email?: unknown })?.Email === "string" &&
				(r as { Email: string }).Email.toLowerCase() === email.toLowerCase(),
		);
		const ids = sentMs.map((ms) => {
			const matches = records.filter(
				(r) => (parseNexudusInstant(r.UtcExpectedArrival) ?? parseNexudusInstant(r.ExpectedArrival)) === ms,
			);
			return matches.length ? matches.reduce((a, b) => (b.Id > a.Id ? b : a)).Id : null;
		});
		return ids.every((id): id is number => id != null) ? ids : null;
	};
	const ids = await attempt();
	if (ids != null) return ids;
	await new Promise((resolve) => setTimeout(resolve, lookupRetry.ms));
	return attempt();
}

// Pause between batches of series deletes; mutable so tests can shrink it.
export const deletePause = { ms: 5000, batch: 8 };

// Delete registrations by Id (captured at registration, so no lookup and no
// duplicate ambiguity) and count what didn't go: `missing` visits were already
// gone (404/410), `failed` ones errored. Never throws. Deletes run in
// sequence, pausing between batches: the public API allows 10 requests / 5 s
// and a token refresh can add a call, so a full 30-visit series must not fire
// at once.
export async function deleteVisitorIds(env: Env, ids: number[]): Promise<{ missing: number; failed: number }> {
	let missing = 0;
	let failed = 0;
	for (let i = 0; i < ids.length; i++) {
		if (i > 0 && i % deletePause.batch === 0) await new Promise((resolve) => setTimeout(resolve, deletePause.ms));
		const res = await nexudusFetch(env, (base, accessToken) =>
			fetch(`${base}/api/public/visitors/${ids[i]}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${accessToken}` },
			}),
		);
		if (res?.ok) continue;
		if (res && (res.status === 404 || res.status === 410)) missing++;
		else {
			if (res) console.warn(`visitor delete failed: HTTP ${res.status}`); // status only, no PII
			failed++;
		}
	}
	return { missing, failed };
}
