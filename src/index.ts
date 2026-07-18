/**
 * Slack → Nexudus visitor registration — custom Slack app backend.
 *
 * There is no native "send a web request" step in Slack Workflow Builder, so
 * instead of Slack POSTing a form to us, this Worker *is* the Slack app:
 *
 *   /visitor slash command  → POST /slack/command      → open a modal (views.open)
 *   member submits the modal → POST /slack/interactivity → verify signature, ack,
 *                              then (in the background) register the visitor in
 *                              Nexudus and DM the member ✅/❌.
 *
 * Auth is Slack's request signature (SLACK_SIGNING_SECRET), not a shared secret.
 * The bot token (SLACK_BOT_TOKEN) is used to open the modal and DM the result.
 *
 * Never log the modal values, visitor fields, tokens, or Nexudus/Slack response
 * bodies — visitor PII must not reach Workers Logs. Slack/Nexudus error *codes*
 * are safe to log.
 */

const CALLBACK_ID = "visitor_registration";
const OPEN_ACTION = "open_visitor_form"; // button that DMs the bot posts to open the modal
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

async function slackApi(env: Env, method: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
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
}

// Post a message. `channel` may be a user id (chat.postMessage opens the IM)
// or a channel id / #name (the bot must be a member of the channel). `blocks`
// is optional Block Kit; `text` remains the notification fallback.
async function postMessage(env: Env, channel: string, text: string, blocks?: unknown[]): Promise<void> {
	const { ok, error } = await slackApi(env, "chat.postMessage", { channel, text, ...(blocks && { blocks }) });
	if (!ok) console.log(`chat.postMessage failed: ${error ?? "unknown"}`); // error code only, no PII
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

// The message a DM to the bot gets back: a button that opens the modal. A plain
// message event carries no trigger_id, so a button (which does) is the only way
// to open a modal in response to a DM.
function formPromptBlocks() {
	return [
		{
			type: "section",
			text: { type: "mrkdwn", text: "Need to register a visitor? Tap the button to open the form." },
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
	];
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
// Nexudus tokens (KV-backed, auto-refreshing)
// ---------------------------------------------------------------------------
//
// The account password never reaches the Worker. It authenticates with an
// access token that lasts ~14 days. When that token 401s we exchange the
// refresh token for a new pair (client_id = the account email) — but Nexudus
// refresh tokens are single-use and rotate on every exchange, so the live pair
// is kept in KV (env.TOKENS) and the new refresh token is written back. The
// NEXUDUS_ACCESS_TOKEN / NEXUDUS_REFRESH_TOKEN secrets are only the initial
// seed, used until the first refresh populates KV; re-seed with
// scripts/nexudus-token.sh if KV is ever cleared.

const TOKEN_KEY = "nexudus";

interface TokenPair {
	access_token: string;
	refresh_token: string;
}

async function readTokens(env: Env): Promise<TokenPair> {
	const raw = await env.TOKENS.get(TOKEN_KEY);
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as Partial<TokenPair>;
			if (typeof parsed.access_token === "string" && typeof parsed.refresh_token === "string") {
				return { access_token: parsed.access_token, refresh_token: parsed.refresh_token };
			}
		} catch {
			// fall through to the seed
		}
	}
	return { access_token: env.NEXUDUS_ACCESS_TOKEN, refresh_token: env.NEXUDUS_REFRESH_TOKEN };
}

// Exchange the (single-use) refresh token for a fresh pair. client_id is the
// account email, sent as a header (Nexudus requirement). Returns null on any
// failure — the caller surfaces a "re-seed" message.
async function refreshTokens(env: Env, base: string, refreshToken: string): Promise<TokenPair | null> {
	const res = await fetch(`${base}/api/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			client_id: env.NEXUDUS_USERNAME,
		},
		body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
	});
	if (!res.ok) return null;
	const body = (await res.json().catch(() => null)) as Partial<TokenPair> | null;
	if (typeof body?.access_token !== "string" || typeof body?.refresh_token !== "string") return null;
	return { access_token: body.access_token, refresh_token: body.refresh_token };
}

// Run an authenticated Nexudus request: current token first; on a 401 refresh
// once (rotating the pair, persisted to KV) and retry. Returns null only when
// auth couldn't be established (the refresh failed) — the re-seed hint goes to
// the log, never to a member (it's not actionable for them).
async function nexudusFetch(
	env: Env,
	base: string,
	doFetch: (accessToken: string) => Promise<Response>,
): Promise<Response | null> {
	const tokens = await readTokens(env);
	let res = await doFetch(tokens.access_token);
	if (res.status === 401) {
		const refreshed = await refreshTokens(env, base, tokens.refresh_token);
		if (!refreshed) {
			console.log("nexudus token refresh failed — re-seed with scripts/nexudus-token.sh");
			return null;
		}
		await env.TOKENS.put(TOKEN_KEY, JSON.stringify(refreshed));
		res = await doFetch(refreshed.access_token);
	}
	return res;
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

interface VisitorInput {
	fullName?: string;
	email?: string;
	phone?: string;
	arrivalEpoch?: number;
	host?: string;
	notes?: string;
	submittedBy: string;
}

// mrkdwn summary of what was submitted, shown under both the ✅ and ❌ headers
// (and in the channel log). Blank optional fields are omitted; arrival is
// space-local, matching what the portal displays.
function submissionSummary(env: Env, input: VisitorInput): string {
	const lines: string[] = [];
	if (input.fullName) lines.push(`*Name:* ${input.fullName}`);
	if (input.email) lines.push(`*Email:* ${input.email}`);
	if (input.phone) lines.push(`*Phone:* ${input.phone}`);
	if (input.arrivalEpoch != null) {
		// drop the seconds — the datetimepicker is minute-granular
		const local = toWallClock(input.arrivalEpoch, env.SPACE_TIMEZONE).replace("T", " ").slice(0, 16);
		lines.push(`*Arrival:* ${local} (${env.SPACE_TIMEZONE})`);
	}
	if (input.host) lines.push(`*Visiting:* ${input.host}`);
	if (input.notes) lines.push(`*Notes:* ${input.notes}`);
	lines.push(`*Submitted by:* ${input.submittedBy}`);
	return lines.join("\n");
}

// What the delete button needs to find the visitor again at click time: the
// create response has no Id, so the button carries the identifying fields and
// the click handler looks the Id up in the visitor list (SPEC §11 → item D).
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

	const base = `https://${env.NEXUDUS_SUBDOMAIN}.spaces.nexudus.com`;

	// All registrations go through one account, so CustomerNotes is reception's
	// only view of who submitted and who the visitor is for.
	const noteLines: string[] = [`Submitted via Slack by ${input.submittedBy}`];
	if (input.host) noteLines.push(`Visiting: ${input.host}`);
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

	const regRes = await nexudusFetch(env, base, (accessToken) =>
		fetch(`${base}/api/public/visitors`, {
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
			body,
		}),
	);

	if (!regRes) {
		// Auth couldn't be renewed — the member can't fix that, so keep it friendly
		// (the operational hint is already in the log, from nexudusFetch).
		return failed(
			"We couldn't connect to the visitor system, so this visitor was not registered. Please try again later — if it keeps failing, let an admin know.",
		);
	}
	if (!regRes.ok) {
		const detail = (await regRes.text().catch(() => "")).slice(0, 300);
		return failed(`Nexudus rejected the registration: ${detail || `HTTP ${regRes.status}`}`);
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
// registrations, which (single-account model, SPEC §7) is exactly the set this
// Worker creates. Match on email (and arrival, when recognizable), DELETE the
// newest match. Docs: learn.nexudus.com/api/endpoints/visitors/list-visitors.

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

// True when a listed record's date denotes the same instant as the naive-UTC
// string we sent.
function arrivalMatches(recordValue: unknown, sentUtc: string): boolean {
	const recordMs = parseNexudusInstant(recordValue);
	return recordMs != null && recordMs === Date.parse(`${sentUtc}Z`);
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
	base: string,
	ref: DeleteRef,
): Promise<{ match: VisitorRecord | null; emailMatches: number } | null> {
	const res = await nexudusFetch(env, base, (accessToken) =>
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
	const exact = byEmail.filter(
		(r) => arrivalMatches(r.UtcExpectedArrival, ref.a) || arrivalMatches(r.ExpectedArrival, ref.a),
	);
	const match = exact.length > 0 ? exact.reduce((a, b) => (b.Id > a.Id ? b : a)) : null;
	return { match, emailMatches: byEmail.length };
}

// The 🗑️ confirmation is built from the record Nexudus actually deleted — not
// from the clicked message — so a mismatch could never pass unnoticed. The
// Nexudus Id is included as the one unambiguous identifier between duplicates.
function deletedSummary(env: Env, r: VisitorRecord): string {
	const lines = ["🗑️ *Registration deleted*"];
	if (typeof r.FullName === "string" && r.FullName) lines.push(`*Name:* ${r.FullName}`);
	lines.push(`*Email:* ${r.Email}`);
	if (typeof r.PhoneNumber === "string" && r.PhoneNumber) lines.push(`*Phone:* ${r.PhoneNumber}`);
	const ms = parseNexudusInstant(r.UtcExpectedArrival) ?? parseNexudusInstant(r.ExpectedArrival);
	if (ms != null) {
		const local = toWallClock(ms / 1000, env.SPACE_TIMEZONE).replace("T", " ").slice(0, 16);
		lines.push(`*Arrival:* ${local} (${env.SPACE_TIMEZONE})`);
	}
	if (typeof r.CustomerNotes === "string" && r.CustomerNotes) lines.push(`*Notes:* ${r.CustomerNotes}`);
	lines.push(`*Nexudus Id:* ${r.Id}`);
	return lines.join("\n");
}

// Delete the visitor the button points at. Returns the member-facing outcome.
async function deleteVisitor(env: Env, ref: DeleteRef): Promise<{ ok: boolean; text: string }> {
	const base = `https://${env.NEXUDUS_SUBDOMAIN}.spaces.nexudus.com`;
	const found = await findVisitor(env, base, ref);
	if (!found) {
		return {
			ok: false,
			text: "⚠️ Couldn't check the visitor list just now — nothing was deleted. Please try again, or remove the visitor in the Nexudus portal.",
		};
	}
	if (!found.match) {
		return {
			ok: false,
			text:
				found.emailMatches > 0
					? "⚠️ There are upcoming registrations for this email, but none with this exact visit time — so nothing was deleted. Please remove the right one in the Nexudus portal."
					: "⚠️ Couldn't find this registration in Nexudus — it may already be deleted, or the visit time has passed. If it still shows in the portal, remove it there.",
		};
	}
	const res = await nexudusFetch(env, base, (accessToken) =>
		fetch(`${base}/api/public/visitors/${found.match!.Id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${accessToken}` },
		}),
	);
	if (!res?.ok) {
		if (res) console.log(`visitor delete failed: HTTP ${res.status}`); // status only, no PII
		return { ok: false, text: "⚠️ Deleting failed — please remove the visitor in the Nexudus portal." };
	}
	return { ok: true, text: deletedSummary(env, found.match) };
}

// Handle a Delete click: delete in Nexudus, then report via the clicked
// message's response_url — replacing it with the deleted record's own details
// on success, or an ephemeral note to the clicker on failure.
async function handleDeleteClick(env: Env, ref: DeleteRef, responseUrl: string): Promise<void> {
	const { ok, text } = await deleteVisitor(env, ref);
	const res = await fetch(responseUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(
			ok
				? { replace_original: true, text }
				: { replace_original: false, response_type: "ephemeral", text },
		),
	});
	if (!res.ok) console.log(`response_url post failed: HTTP ${res.status}`);
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
				console.log(`views.open failed: ${error ?? "unknown"}`);
				return new Response("Couldn't open the visitor form — please try again.", { status: 200 });
			}
			return new Response("", { status: 200 });
		}

		if (path === "/slack/events") {
			// Events API (application/json). A DM to the bot → reply with a button
			// that opens the modal. Ack fast; post in the background.
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
			// Only a real user's DM message — ignore the bot's own posts and edits.
			if (e.type === "message" && e.channel_type === "im" && !e.bot_id && !e.subtype && e.channel) {
				ctx.waitUntil(
					slackApi(env, "chat.postMessage", {
						channel: e.channel,
						text: "Register a visitor",
						blocks: formPromptBlocks(),
					}),
				);
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
				if (!ok) console.log(`views.open failed: ${error ?? "unknown"}`);
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
				registerVisitor(env, input).then(async ({ ok, message, blocks }) => {
					await postMessage(env, userId, message, blocks);
					// Successes also go to the visitors channel — the human-readable
					// log of registrations. Failures stay in the submitter's DM.
					if (ok && env.VISITOR_CHANNEL) await postMessage(env, env.VISITOR_CHANNEL, message, blocks);
				}),
			);
		}
		return new Response("", { status: 200 });
	},
} satisfies ExportedHandler<Env>;
