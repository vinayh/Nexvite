/**
 * Slack → Nexudus visitor registration — custom Slack app backend.
 *
 * This Worker *is* the Slack app (Workflow Builder has no outbound-HTTP step):
 * /slack/command opens the modal, /slack/events publishes the App Home tab
 * (whose button also opens the modal), and /slack/interactivity verifies the
 * signature, acks, then registers the visitor in Nexudus and DMs the result.
 * Flow diagram and design rationale: README.md.
 *
 * Never log the modal values, visitor fields, tokens, or Nexudus/Slack response
 * bodies — visitor PII must not reach Workers Logs. Slack/Nexudus error *codes*
 * are safe to log.
 */

const CALLBACK_ID = "visitor_registration";
const OPEN_ACTION = "open_visitor_form"; // the Home-tab button that opens the modal
const DELETE_ACTION = "delete_visitor"; // button on the ✅ confirmation messages

// Modal block/action ids → how we read each value back out of view.state.values.
const FIELDS = {
	fullName: { block: "full_name", action: "value", cap: 200 },
	email: { block: "email", action: "value", cap: 320 },
	phone: { block: "phone", action: "value", cap: 50 },
	arrival: { block: "arrival", action: "value" },
	host: { block: "host", action: "value", cap: 200 },
	notes: { block: "notes", action: "value", cap: 1000 },
} as const;

const SLACK_API = "https://slack.com/api";

// ---------------------------------------------------------------------------
// Slack request signature (https://api.slack.com/authentication/verifying-requests-from-slack)
// ---------------------------------------------------------------------------

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const ab = enc.encode(a);
	const bb = enc.encode(b);
	if (ab.byteLength !== bb.byteLength) return false;
	return crypto.subtle.timingSafeEqual(ab, bb);
}

// Verify `v0=HMAC-SHA256(signing_secret, "v0:{ts}:{body}")` and reject stale
// timestamps (replay protection). `rawBody` must be the exact bytes received.
async function verifySlackSignature(
	request: Request,
	rawBody: string,
	signingSecret: string,
): Promise<boolean> {
	const timestamp = request.headers.get("X-Slack-Request-Timestamp");
	const signature = request.headers.get("X-Slack-Signature");
	if (!timestamp || !signature) return false;

	const age = Math.abs(Date.now() / 1000 - Number(timestamp));
	if (!Number.isFinite(age) || age > 60 * 5) return false;

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(signingSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
	return constantTimeEqual(`v0=${hex(mac)}`, signature);
}

// ---------------------------------------------------------------------------
// Slack Web API
// ---------------------------------------------------------------------------

// Never throws — a Slack network failure must not 500 the endpoint or kill the
// background notify chain (a failed DM should still let the channel log post).
async function slackApi(env: Env, method: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch(`${SLACK_API}/${method}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify(body),
		});
		const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
		return { ok: Boolean(json?.ok), error: json?.error };
	} catch {
		return { ok: false, error: "network_error" };
	}
}

// Post a message. `channel` may be a user id (chat.postMessage opens the IM)
// or a channel id / #name (the bot must be a member of the channel). `blocks`
// is optional Block Kit; `text` remains the notification fallback.
async function postMessage(env: Env, channel: string, text: string, blocks?: unknown[]): Promise<void> {
	const { ok, error } = await slackApi(env, "chat.postMessage", { channel, text, ...(blocks && { blocks }) });
	if (!ok) console.warn(`chat.postMessage failed: ${error ?? "unknown"}`); // error code only, no PII
}

// The interactivity payload only carries the submitter's *username* — the
// profile's full name needs a users.info lookup (scope: users:read). Returns
// null on any failure so the caller can keep the username as a fallback.
async function fetchFullName(env: Env, userId: string): Promise<string | null> {
	try {
		const res = await fetch(`${SLACK_API}/users.info?user=${encodeURIComponent(userId)}`, {
			headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
		});
		const json = (await res.json().catch(() => null)) as {
			ok?: boolean;
			error?: string;
			user?: { real_name?: string; profile?: { real_name?: string } };
		} | null;
		if (!json?.ok) {
			console.warn(`users.info failed: ${json?.error ?? "unknown"}`); // error code only, no PII
			return null;
		}
		return json.user?.profile?.real_name || json.user?.real_name || null;
	} catch {
		return null;
	}
}

// Member-provided text goes into mrkdwn messages (DM + channel log); escape
// Slack's control characters so a visitor name/note can't smuggle in a
// mention like <!channel>. https://docs.slack.dev/messaging/formatting-message-text
function mrkdwnEscape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

function inputBlock(
	block: string,
	action: string,
	label: string,
	element: Record<string, unknown>,
	optional = false,
) {
	return {
		type: "input",
		block_id: block,
		optional,
		label: { type: "plain_text", text: label },
		element: { action_id: action, ...element },
	};
}

function visitorModal() {
	return {
		type: "modal",
		callback_id: CALLBACK_ID,
		title: { type: "plain_text", text: "Register a visitor" },
		submit: { type: "plain_text", text: "Register" },
		close: { type: "plain_text", text: "Cancel" },
		blocks: [
			inputBlock(FIELDS.fullName.block, FIELDS.fullName.action, "Full name", {
				type: "plain_text_input",
			}),
			inputBlock(FIELDS.email.block, FIELDS.email.action, "Email", { type: "email_text_input" }),
			inputBlock(FIELDS.phone.block, FIELDS.phone.action, "Phone", { type: "plain_text_input" }, true),
			// datetimepicker returns `selected_date_time` as epoch SECONDS.
			inputBlock(FIELDS.arrival.block, FIELDS.arrival.action, "Expected arrival", {
				type: "datetimepicker",
			}),
			inputBlock(
				FIELDS.host.block,
				FIELDS.host.action,
				"Who are they visiting?",
				{ type: "plain_text_input" },
				true,
			),
			inputBlock(
				FIELDS.notes.block,
				FIELDS.notes.action,
				"Notes",
				{ type: "plain_text_input", multiline: true },
				true,
			),
		],
	};
}

// Open the modal from a trigger_id (slash command or the DM button click).
function openModal(env: Env, triggerId: string) {
	return slackApi(env, "views.open", { trigger_id: triggerId, view: visitorModal() });
}

// The App Home tab: the button entry point, visible to every workspace user
// who opens the app. The tab itself can't open a modal — but its button click
// arrives as block_actions with a trigger_id, which is what views.open needs.
function homeView() {
	return {
		type: "home",
		blocks: [
			{ type: "header", text: { type: "plain_text", text: "Visitor registration" } },
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "Expecting a guest? Register them so reception knows they're coming. You can also run `/visitor` from any channel.",
				},
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Register a visitor" },
						style: "primary",
						action_id: OPEN_ACTION,
					},
				],
			},
		],
	};
}

// (Re)publish the Home tab for one user — done on every app_home_opened.
async function publishHome(env: Env, userId: string): Promise<void> {
	const { ok, error } = await slackApi(env, "views.publish", { user_id: userId, view: homeView() });
	if (!ok) console.warn(`views.publish failed: ${error ?? "unknown"}`); // error code only, no PII
}

// ---------------------------------------------------------------------------
// view_submission value extraction
// ---------------------------------------------------------------------------

type ViewState = {
	values?: Record<string, Record<string, { value?: unknown; selected_date_time?: unknown }>>;
};

// Trimmed, length-capped string; undefined when absent or blank.
function readText(state: ViewState, block: string, action: string, cap: number): string | undefined {
	const raw = state.values?.[block]?.[action]?.value;
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed ? trimmed.slice(0, cap) : undefined;
}

function readDateTime(state: ViewState, block: string, action: string): number | undefined {
	const dt = state.values?.[block]?.[action]?.selected_date_time;
	return typeof dt === "number" && Number.isFinite(dt) ? dt : undefined;
}

// ---------------------------------------------------------------------------
// Nexudus auth (KV-backed, auto-refreshing)
// ---------------------------------------------------------------------------
//
// Nexudus refresh tokens are single-use and rotate on every exchange, so the
// live auth record lives in KV (env.TOKENS) — shared with the Nexroom Worker,
// which binds the same namespace. There is no other credential source: seed
// (or re-seed after a broken chain) with
// scripts/nexudus-token.sh | scripts/nexudus-seed.sh.

export const TOKEN_KEY = "nexudus"; // exported for the tests

interface NexudusAuth {
	username: string; // account email — the client_id header on refresh
	access_token: string;
	refresh_token: string;
}

// Read the live auth record. Returns null when the KV key is missing or
// malformed (including a legacy pair without `username`) — that means
// "unseeded", not "fall back to something else".
async function readAuth(env: Env): Promise<NexudusAuth | null> {
	const raw = await env.TOKENS.get(TOKEN_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<NexudusAuth>;
		if (
			typeof parsed.username === "string" &&
			typeof parsed.access_token === "string" &&
			typeof parsed.refresh_token === "string"
		) {
			return { username: parsed.username, access_token: parsed.access_token, refresh_token: parsed.refresh_token };
		}
	} catch {
		// malformed — treat as unseeded
	}
	return null;
}

// Contact address for member-facing failure messages — the Nexudus account
// email from the KV auth record (registrations live under the service account,
// so members can't see them in their own portal login), or a generic fallback
// when KV itself is the problem.
async function nexudusContact(env: Env): Promise<string> {
	try {
		return (await readAuth(env))?.username ?? "the space team";
	} catch {
		return "the space team";
	}
}

// Exchange the (single-use) refresh token for a fresh pair. client_id is the
// account email, sent as a header (Nexudus requirement). Returns null on any
// failure — the caller surfaces a "re-seed" message.
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
// once (rotating the record, persisted to KV) and retry. Never throws. Returns
// null when auth couldn't be established or the network failed — the caller
// turns that into a friendly member-facing failure, while the operational
// detail goes to the log (it's not actionable for members).
async function nexudusFetch(
	env: Env,
	doFetch: (base: string, accessToken: string) => Promise<Response>,
): Promise<Response | null> {
	const base = nexudusBase(env);
	try {
		const auth = await readAuth(env);
		if (!auth) {
			console.error("nexudus auth missing from KV — seed with scripts/nexudus-token.sh | scripts/nexudus-seed.sh");
			return null;
		}
		let res = await doFetch(base, auth.access_token);
		if (res.status === 401) {
			const refreshed = await refreshAuth(base, auth);
			if (!refreshed) {
				console.error("nexudus token refresh failed — re-seed with scripts/nexudus-token.sh | scripts/nexudus-seed.sh");
				return null;
			}
			await env.TOKENS.put(TOKEN_KEY, JSON.stringify(refreshed));
			res = await doFetch(base, refreshed.access_token);
		}
		return res;
	} catch (err) {
		console.error(`nexudus request threw: ${err instanceof Error ? err.name : "unknown"}`); // no PII
		return null;
	}
}

// ---------------------------------------------------------------------------
// Nexudus registration
// ---------------------------------------------------------------------------

// Epoch seconds → naive "YYYY-MM-DDTHH:mm:ss" in `timeZone` (no offset suffix).
function toWallClock(epochSeconds: number, timeZone: string): string {
	const wallClock = new Intl.DateTimeFormat("sv-SE", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date(epochSeconds * 1000));
	return wallClock.replace(" ", "T");
}

// mrkdwn arrival line, space-local and minute-granular (like the datetimepicker),
// e.g. "*Arrival:* 2026-07-20 15:30 (Europe/London)".
function arrivalLine(env: Env, epochSeconds: number): string {
	const local = toWallClock(epochSeconds, env.SPACE_TIMEZONE).replace("T", " ").slice(0, 16);
	return `*Arrival:* ${local} (${env.SPACE_TIMEZONE})`;
}

interface VisitorInput {
	fullName?: string;
	email?: string;
	phone?: string;
	arrivalEpoch?: number;
	host?: string;
	notes?: string;
	submittedBy: string;
}

// CustomerNotes line prefixes — written by registerVisitor, parsed back out
// by deletedSummary so the 🗑️ message can mirror the ✅ summary's lines.
const NOTE_SUBMITTED = "Submitted via Slack by ";
const NOTE_VISITING = "Visiting: ";

// mrkdwn summary of what was submitted, shown under both the ✅ and ❌ headers
// (and in the channel log). Blank optional fields are omitted; arrival is
// space-local, matching what the portal displays.
function submissionSummary(env: Env, input: VisitorInput): string {
	const lines: string[] = [];
	if (input.fullName) lines.push(`*Name:* ${mrkdwnEscape(input.fullName)}`);
	if (input.email) lines.push(`*Email:* ${mrkdwnEscape(input.email)}`);
	if (input.phone) lines.push(`*Phone:* ${mrkdwnEscape(input.phone)}`);
	if (input.arrivalEpoch != null) lines.push(arrivalLine(env, input.arrivalEpoch));
	if (input.host) lines.push(`*Visiting:* ${mrkdwnEscape(input.host)}`);
	if (input.notes) lines.push(`*Notes:* ${mrkdwnEscape(input.notes)}`);
	lines.push(`*Submitted by:* ${mrkdwnEscape(input.submittedBy)}`);
	return lines.join("\n");
}

// What the delete button needs to find the visitor again at click time: the
// create response has no Id, so the button carries the identifying fields and
// the click handler looks the Id up in the visitor list (README, delete flow).
interface DeleteRef {
	e: string; // email
	a: string; // ExpectedArrival exactly as sent to Nexudus (naive UTC)
}

// Success message blocks: the summary plus a Delete button (with a Slack-side
// confirm dialog) carrying the DeleteRef in its value.
function successBlocks(text: string, ref: DeleteRef): unknown[] {
	return [
		{ type: "section", text: { type: "mrkdwn", text } },
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Delete registration" },
					style: "danger",
					action_id: DELETE_ACTION,
					value: JSON.stringify(ref),
					confirm: {
						title: { type: "plain_text", text: "Delete this registration?" },
						text: { type: "plain_text", text: "The visitor will be removed from Nexudus." },
						confirm: { type: "plain_text", text: "Delete" },
						deny: { type: "plain_text", text: "Keep" },
					},
				},
			],
		},
	];
}

interface RegistrationResult {
	ok: boolean;
	message: string; // DMed to the submitter; also posted to the channel log when ok
	blocks?: unknown[]; // present on success (summary + delete button)
}

// Registers the visitor and builds the result message. Never throws.
async function registerVisitor(env: Env, input: VisitorInput): Promise<RegistrationResult> {
	const summary = submissionSummary(env, input);
	const failed = (reason: string): RegistrationResult => ({
		ok: false,
		message: `❌ *Registration failed*\n${reason}\n${summary}`,
	});

	if (!input.fullName || !input.email || input.arrivalEpoch == null) {
		return failed("Full name, email and expected arrival are all required.");
	}
	// Nexudus interprets the naive ExpectedArrival as UTC and shows it in the
	// space's local timezone in the portal, so send the UTC wall-clock (the
	// summary echoes the space-local time, matching what the portal shows).
	const arrivalUtc = toWallClock(input.arrivalEpoch, "UTC");

	// All registrations go through one account, so CustomerNotes is reception's
	// only view of who submitted and who the visitor is for.
	const noteLines: string[] = [`${NOTE_SUBMITTED}${input.submittedBy}`];
	if (input.host) noteLines.push(`${NOTE_VISITING}${input.host}`);
	if (input.notes) noteLines.push(input.notes);

	const visitor = {
		BusinessId: Number(env.NEXUDUS_BUSINESS_ID), // config only — never from the request
		FullName: input.fullName,
		Email: input.email,
		PhoneNumber: input.phone,
		ExpectedArrival: arrivalUtc,
		CustomerNotes: noteLines.join("\n"),
	};
	const body = JSON.stringify([visitor]); // body is an array of visitors

	const regRes = await nexudusFetch(env, (base, accessToken) =>
		fetch(`${base}/api/public/visitors`, {
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
			body,
		}),
	);
	if (!regRes) {
		return failed(
			`We couldn't connect to the visitor system, so this visitor was not registered. Please try again later — if it keeps failing, contact ${await nexudusContact(env)}.`,
		);
	}
	if (!regRes.ok) {
		const detail = (await regRes.text().catch(() => "")).slice(0, 300);
		return failed(`Nexudus rejected the registration: ${detail ? mrkdwnEscape(detail) : `HTTP ${regRes.status}`}`);
	}

	const message = `✅ *Visitor registered*\n${summary}`;
	return { ok: true, message, blocks: successBlocks(message, { e: input.email, a: arrivalUtc }) };
}

// ---------------------------------------------------------------------------
// Deletion (the ✅ message's Delete button)
// ---------------------------------------------------------------------------
//
// The create response carries no visitor Id, so deletion is a click-time
// lookup via GET /api/public/visitors/my — the authenticated customer's own
// registrations, which (single-account model, see README) is exactly the set this
// Worker creates. Match strictly on email + visit instant, DELETE the newest
// match. Docs: learn.nexudus.com/api/endpoints/visitors/list-visitors.

// Parse a Nexudus date value to epoch milliseconds. Tolerates ISO strings
// (naive ones are treated as UTC — matching what we send) and the legacy
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
	FullName?: unknown;
	PhoneNumber?: unknown;
	ExpectedArrival?: unknown;
	UtcExpectedArrival?: unknown;
	CustomerNotes?: unknown;
}

// Look up the visitor to delete among the account's own registrations. Returns
// null when the list itself couldn't be fetched. Only exact email+arrival
// matches qualify — deleting a best guess is how the *wrong* duplicate would
// vanish without the member noticing. Among exact duplicates (double-submit),
// the newest Id wins; any copy is the right one to remove there.
// showUpcoming keeps the payload bounded — a visitor whose arrival already
// passed can't be looked up (deleting would be moot).
async function findVisitor(
	env: Env,
	ref: DeleteRef,
): Promise<{ match: VisitorRecord | null; emailMatches: number } | null> {
	const res = await nexudusFetch(env, (base, accessToken) =>
		fetch(`${base}/api/public/visitors/my?showUpcoming=true`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		}),
	);
	if (!res?.ok) return null;
	const records = listRecords(await res.json().catch(() => null));
	const byEmail = records.filter(
		(r): r is VisitorRecord =>
			typeof (r as { Id?: unknown })?.Id === "number" &&
			typeof (r as { Email?: unknown })?.Email === "string" &&
			(r as { Email: string }).Email.toLowerCase() === ref.e.toLowerCase(),
	);
	// UtcExpectedArrival wins whenever it parses: ExpectedArrival can be
	// space-local, so consulting it alongside the UTC field would let a visit
	// one offset-hour away match by string coincidence. It's the fallback only
	// when no UTC field is usable.
	const sentMs = Date.parse(`${ref.a}Z`);
	const exact = byEmail.filter(
		(r) => (parseNexudusInstant(r.UtcExpectedArrival) ?? parseNexudusInstant(r.ExpectedArrival)) === sentMs,
	);
	const match = exact.length > 0 ? exact.reduce((a, b) => (b.Id > a.Id ? b : a)) : null;
	return { match, emailMatches: byEmail.length };
}

// The 🗑️ confirmation is built from the record Nexudus actually deleted — not
// from the clicked message — so a mismatch could never pass unnoticed. It
// mirrors the ✅ summary's lines (CustomerNotes parsed back into Visiting /
// Notes / Submitted by), with the Nexudus ID added as the one unambiguous
// identifier between duplicates.
function deletedSummary(env: Env, r: VisitorRecord): string {
	const lines = ["🗑️ *Registration deleted*"];
	if (typeof r.FullName === "string" && r.FullName) lines.push(`*Name:* ${mrkdwnEscape(r.FullName)}`);
	lines.push(`*Email:* ${mrkdwnEscape(r.Email)}`);
	if (typeof r.PhoneNumber === "string" && r.PhoneNumber) lines.push(`*Phone:* ${mrkdwnEscape(r.PhoneNumber)}`);
	const ms = parseNexudusInstant(r.UtcExpectedArrival) ?? parseNexudusInstant(r.ExpectedArrival);
	if (ms != null) lines.push(arrivalLine(env, ms / 1000));
	const noteLines = typeof r.CustomerNotes === "string" ? r.CustomerNotes.split("\n") : [];
	const submittedBy = noteLines.find((l) => l.startsWith(NOTE_SUBMITTED))?.slice(NOTE_SUBMITTED.length);
	const visiting = noteLines.find((l) => l.startsWith(NOTE_VISITING))?.slice(NOTE_VISITING.length);
	const rest = noteLines.filter((l) => !l.startsWith(NOTE_SUBMITTED) && !l.startsWith(NOTE_VISITING)).join("\n");
	if (visiting) lines.push(`*Visiting:* ${mrkdwnEscape(visiting)}`);
	if (rest) lines.push(`*Notes:* ${mrkdwnEscape(rest)}`);
	if (submittedBy) lines.push(`*Submitted by:* ${mrkdwnEscape(submittedBy)}`);
	lines.push(`*Nexudus ID:* ${r.Id}`);
	return lines.join("\n");
}

// Delete the visitor the button points at. Returns the member-facing outcome.
// Never throws — a network failure must still produce feedback for the clicker.
async function deleteVisitor(env: Env, ref: DeleteRef): Promise<{ ok: boolean; text: string }> {
	// Failure fallback is the Nexudus account email (see nexudusContact), not
	// "the portal" — members can't see these registrations in their own login.
	const contact = await nexudusContact(env);
	const found = await findVisitor(env, ref);
	if (!found) {
		return {
			ok: false,
			text: `⚠️ Couldn't check the visitor list just now — nothing was deleted. Please try again — if it keeps failing, contact ${contact}.`,
		};
	}
	const { match } = found;
	if (!match) {
		return {
			ok: false,
			text:
				found.emailMatches > 0
					? `⚠️ There are upcoming registrations for this email, but none with this exact visit time — so nothing was deleted. Contact ${contact} to remove the right one.`
					: `⚠️ Couldn't find this registration — it may already be deleted, or the visit time has passed. If it still needs removing, contact ${contact}.`,
		};
	}
	const res = await nexudusFetch(env, (base, accessToken) =>
		fetch(`${base}/api/public/visitors/${match.Id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${accessToken}` },
		}),
	);
	if (!res?.ok) {
		if (res) console.warn(`visitor delete failed: HTTP ${res.status}`); // status only, no PII
		return { ok: false, text: `⚠️ Deleting failed — please contact ${contact} to remove the visitor.` };
	}
	return { ok: true, text: deletedSummary(env, match) };
}

// Handle a Delete click: delete in Nexudus, then report via the clicked
// message's response_url — replacing it with the deleted record's own details
// on success, or an ephemeral note to the clicker on failure.
async function handleDeleteClick(env: Env, ref: DeleteRef, responseUrl: string): Promise<void> {
	const { ok, text } = await deleteVisitor(env, ref);
	try {
		const res = await fetch(responseUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				ok
					? { replace_original: true, text }
					: { replace_original: false, response_type: "ephemeral", text },
			),
		});
		if (!res.ok) console.warn(`response_url post failed: HTTP ${res.status}`);
	} catch (err) {
		console.warn(`response_url post threw: ${err instanceof Error ? err.name : "unknown"}`); // no PII
	}
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type SlackUser = { id?: string; name?: string; username?: string };

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path !== "/slack/command" && path !== "/slack/interactivity" && path !== "/slack/events") {
			return new Response("Not found", { status: 404 });
		}
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		// Per-IP flood insurance, checked before the HMAC work (wrangler.jsonc
		// `ratelimits`). Slack retries a 429ed event, so a burst degrades
		// gracefully. Fail open — losing the limiter must not down the endpoint.
		try {
			const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
			const { success } = await env.RATE_LIMITER.limit({ key: ip });
			if (!success) return new Response("Rate limited", { status: 429 });
		} catch {
			// limiter unavailable — let the request through
		}

		// Read the raw bytes (needed verbatim for the HMAC). Decoding via
		// TextDecoder rather than request.text() avoids workerd's noisy
		// "not text" warning for the application/x-www-form-urlencoded body.
		const rawBody = new TextDecoder().decode(await request.arrayBuffer());
		if (!(await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET))) {
			return new Response("Invalid signature", { status: 401 });
		}

		if (path === "/slack/command") {
			// Slash command: open the modal with the trigger_id (expires in ~3s).
			const triggerId = new URLSearchParams(rawBody).get("trigger_id");
			if (!triggerId) return new Response("", { status: 200 });

			const { ok, error } = await openModal(env, triggerId);
			if (!ok) {
				console.warn(`views.open failed: ${error ?? "unknown"}`);
				return new Response("Couldn't open the visitor form — please try again.", { status: 200 });
			}
			return new Response("", { status: 200 });
		}

		if (path === "/slack/events") {
			// Events API (application/json). The only subscribed event is
			// app_home_opened → (re)publish the Home tab. DMs to the bot are
			// deliberately not an entry point. Ack fast; publish in the background.
			let event: { type?: string; challenge?: string; event?: Record<string, unknown> };
			try {
				event = JSON.parse(rawBody);
			} catch {
				return new Response("", { status: 200 });
			}
			if (event.type === "url_verification") {
				return new Response(event.challenge ?? "", { status: 200 });
			}
			const e = event.event ?? {};
			// tab === "home" only — the event also fires for the Messages tab.
			if (e.type === "app_home_opened" && e.tab === "home" && typeof e.user === "string") {
				ctx.waitUntil(publishHome(env, e.user));
			}
			return new Response("", { status: 200 });
		}

		// path === "/slack/interactivity"
		const payloadRaw = new URLSearchParams(rawBody).get("payload");
		let payload: {
			type?: string;
			user?: SlackUser;
			trigger_id?: string;
			response_url?: string;
			actions?: Array<{ action_id?: string; value?: string }>;
			view?: { callback_id?: string; state?: ViewState };
		};
		try {
			payload = JSON.parse(payloadRaw ?? "");
		} catch {
			return new Response("", { status: 200 });
		}

		// Button clicks: the DM prompt's "Register a visitor" opens the modal;
		// a confirmation's "Delete registration" removes the visitor again.
		if (payload.type === "block_actions") {
			const clickedOpen = (payload.actions ?? []).some((a) => a.action_id === OPEN_ACTION);
			const clickedDelete = (payload.actions ?? []).find((a) => a.action_id === DELETE_ACTION);
			if (clickedOpen && payload.trigger_id) {
				const { ok, error } = await openModal(env, payload.trigger_id);
				if (!ok) console.warn(`views.open failed: ${error ?? "unknown"}`);
			} else if (clickedDelete?.value && payload.response_url) {
				let ref: DeleteRef | null = null;
				try {
					const parsed = JSON.parse(clickedDelete.value) as Partial<DeleteRef>;
					if (typeof parsed.e === "string" && typeof parsed.a === "string") ref = { e: parsed.e, a: parsed.a };
				} catch {
					// stale/foreign button value — ignore
				}
				if (ref) {
					ctx.waitUntil(handleDeleteClick(env, ref, payload.response_url));
				}
			}
			return new Response("", { status: 200 });
		}

		if (payload.type !== "view_submission" || payload.view?.callback_id !== CALLBACK_ID) {
			return new Response("", { status: 200 }); // not ours / not a submission — ack and ignore
		}

		const state = payload.view?.state ?? {};
		const userId = payload.user?.id;
		const input: VisitorInput = {
			fullName: readText(state, FIELDS.fullName.block, FIELDS.fullName.action, FIELDS.fullName.cap),
			email: readText(state, FIELDS.email.block, FIELDS.email.action, FIELDS.email.cap),
			phone: readText(state, FIELDS.phone.block, FIELDS.phone.action, FIELDS.phone.cap),
			arrivalEpoch: readDateTime(state, FIELDS.arrival.block, FIELDS.arrival.action),
			host: readText(state, FIELDS.host.block, FIELDS.host.action, FIELDS.host.cap),
			notes: readText(state, FIELDS.notes.block, FIELDS.notes.action, FIELDS.notes.cap),
			submittedBy: payload.user?.name ?? payload.user?.username ?? "a Slack user",
		};

		// Register + notify in the background so we ack within Slack's 3s window.
		// Acking with an empty 200 closes the modal.
		if (userId) {
			ctx.waitUntil(
				(async () => {
					// Upgrade the username to the profile's full name when we can.
					input.submittedBy = (await fetchFullName(env, userId)) ?? input.submittedBy;
					const { ok, message, blocks } = await registerVisitor(env, input);
					await postMessage(env, userId, message, blocks);
					// Successes also go to the visitors channel — the human-readable
					// log of registrations. Failures stay in the submitter's DM.
					if (ok && env.VISITOR_CHANNEL) await postMessage(env, env.VISITOR_CHANNEL, message, blocks);
				})(),
			);
		}
		return new Response("", { status: 200 });
	},
} satisfies ExportedHandler<Env>;
