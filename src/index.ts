/**
 * Backend for the Nexvite Slack app: visitor registration from Slack into
 * Nexudus.
 *
 * /slack/command opens the registration modal, /slack/events publishes the
 * App Home tab (whose button also opens the modal), and /slack/interactivity
 * verifies the signature, acks the submission with a "registering" placeholder
 * modal, registers the visitor in Nexudus in the background, then updates the
 * modal and DMs the result. The DM is the durable record. Flow diagram and
 * design rationale: README.md.
 *
 * Never log modal values, visitor fields, tokens, or Nexudus/Slack response
 * bodies; visitor PII must not reach Workers Logs. Slack and Nexudus error
 * codes are safe to log.
 */

const CALLBACK_ID = "visitor_registration";
const OPEN_ACTION = "open_visitor_form"; // the Home-tab button that opens the modal
const DELETE_ACTION = "delete_visitor"; // button on the ✅ confirmation messages

// Modal block/action ids, used to read each value from view.state.values.
const FIELDS = {
	fullName: { block: "full_name", action: "value", cap: 200 },
	email: { block: "email", action: "value", cap: 320 },
	phone: { block: "phone", action: "value", cap: 50 },
	arrivalDate: { block: "arrival_date", action: "value" },
	arrivalTime: { block: "arrival_time", action: "value" },
	repeat: { block: "repeat", action: "value" },
	repeatUntil: { block: "repeat_until", action: "value" },
	host: { block: "host", action: "value", cap: 200 },
	notes: { block: "notes", action: "value", cap: 1000 },
} as const;

// The cadences offered by the modal's "Repeat visit" select. Expansion steps
// through calendar dates in SPACE_TIMEZONE date space; every occurrence keeps
// the first visit's wall-clock time. Nexudus has no recurrence field — a
// repeating visit is just one visitor object per date in a single create
// request (README) — so a series is capped like the Nexudus portal's own
// "up to 30 visits in one go".
const REPEATS = {
	none: { label: "Does not repeat", stepDays: 0 },
	daily: { label: "Every day", stepDays: 1 },
	weekdays: { label: "Every weekday (Mon–Fri)", stepDays: 1 },
	weekly: { label: "Every week", stepDays: 7 },
	fortnightly: { label: "Every 2 weeks", stepDays: 14 },
} as const;
type RepeatKey = keyof typeof REPEATS;
const MAX_VISITS = 30;

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
async function verifySlackSignature(request: Request, rawBody: string, signingSecret: string): Promise<boolean> {
	const timestamp = request.headers.get("X-Slack-Request-Timestamp");
	const signature = request.headers.get("X-Slack-Signature");
	if (!timestamp || !signature) return false;

	const age = Math.abs(Date.now() / 1000 - Number(timestamp));
	if (!Number.isFinite(age) || age > 60 * 5) return false;

	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
	return constantTimeEqual(`v0=${hex(mac)}`, signature);
}

// ---------------------------------------------------------------------------
// Slack Web API
// ---------------------------------------------------------------------------

// Never throws: a Slack network failure must not 500 the endpoint or stop the
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

// A Slack call whose failure is only log-worthy: warn with the error code
// (never PII) and move on.
async function slackApiWarn(env: Env, method: string, body: unknown): Promise<void> {
	const { ok, error } = await slackApi(env, method, body);
	if (!ok) console.warn(`${method} failed: ${error ?? "unknown"}`);
}

// Post a message. `channel` may be a user id (chat.postMessage opens the IM)
// or a channel id / #name (the bot must be a member of the channel). `blocks`
// is optional Block Kit; `text` remains the notification fallback.
function postMessage(env: Env, channel: string, text: string, blocks?: unknown[]): Promise<void> {
	return slackApiWarn(env, "chat.postMessage", { channel, text, ...(blocks && { blocks }) });
}

// The interactivity payload only carries the submitter's username; the
// profile's full name needs a users.info lookup (scope: users:read). Returns
// null on any failure so the caller can fall back to the username.
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

function inputBlock(block: string, action: string, label: string, element: Record<string, unknown>, optional = false, hint?: string) {
	return {
		type: "input",
		block_id: block,
		optional,
		label: { type: "plain_text", text: label },
		element: { action_id: action, ...element },
		...(hint && { hint: { type: "plain_text", text: hint } }),
	};
}

function repeatOption(key: RepeatKey) {
	return { text: { type: "plain_text", text: REPEATS[key].label }, value: key };
}

function visitorModal(env: Env) {
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
			// Naive date + time pickers, not a datetimepicker: a datetimepicker
			// renders in each member's own timezone, so the instant it submits
			// depends on who submitted it. These values are read as SPACE_TIMEZONE
			// wall-clock; the labels name that timezone because for a member
			// abroad the field is *not* their local time.
			inputBlock(FIELDS.arrivalDate.block, FIELDS.arrivalDate.action, `Expected arrival — date (${env.SPACE_TIMEZONE})`, {
				type: "datepicker",
			}),
			inputBlock(
				FIELDS.arrivalTime.block,
				FIELDS.arrivalTime.action,
				`Expected arrival — time (${env.SPACE_TIMEZONE})`,
				{ type: "timepicker" },
				false,
				`Time at the space (${env.SPACE_TIMEZONE}), not your own time zone.`,
			),
			// Repeat cadence + inclusive end date; the arrival above is the first
			// visit. "Repeat until" must be optional so Slack doesn't demand it on
			// single-visit submissions; picking a cadence without it is bounced
			// with an inline error instead.
			inputBlock(FIELDS.repeat.block, FIELDS.repeat.action, "Repeat visit", {
				type: "static_select",
				initial_option: repeatOption("none"),
				options: (Object.keys(REPEATS) as RepeatKey[]).map(repeatOption),
			}),
			inputBlock(
				FIELDS.repeatUntil.block,
				FIELDS.repeatUntil.action,
				`Repeat until (${env.SPACE_TIMEZONE})`,
				{ type: "datepicker" },
				true,
				`Last possible visit date when repeating — up to ${MAX_VISITS} visits.`,
			),
			inputBlock(FIELDS.host.block, FIELDS.host.action, "Who are they visiting?", { type: "plain_text_input" }, true),
			inputBlock(FIELDS.notes.block, FIELDS.notes.action, "Notes", { type: "plain_text_input", multiline: true }, true),
		],
	};
}

// Open the modal from a trigger_id (slash command or the Home-tab button click).
function openModal(env: Env, triggerId: string) {
	return slackApi(env, "views.open", { trigger_id: triggerId, view: visitorModal(env) });
}

// The post-submission modal: a single-message view, no inputs. Shown first as a
// "⏳ registering" placeholder (returned inline via response_action:update on the
// submission), then swapped for the ✅/❌/⚠️ result via views.update once Nexudus
// responds. It's live feedback only; the DM (and its Delete button) is the
// durable record, so closing the window loses nothing.
function statusModal(text: string) {
	return {
		type: "modal",
		title: { type: "plain_text", text: "Visitor registration" }, // ≤24 chars
		close: { type: "plain_text", text: "Close" },
		blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
	};
}

// Placeholder shown on submission while registration runs in the background.
function registeringText(visitCount: number): string {
	const head = visitCount > 1 ? `⏳ *Registering ${visitCount} visits…*` : "⏳ *Registering your visitor…*";
	return `${head}\nThis usually takes a few seconds. You'll get a direct message with the result — you can close this window any time.`;
}

// Swap the post-submission placeholder for the result, if the submitter still
// has the modal open. A closed or expired view makes this a no-op (the DM
// already carries the outcome), so a failure here is only logged.
function updateStatusModal(env: Env, viewId: string, text: string): Promise<void> {
	return slackApiWarn(env, "views.update", { view_id: viewId, view: statusModal(text) });
}

// The App Home tab: the button entry point for every workspace user. The tab
// can't open a modal itself, but its button click arrives as block_actions with
// a trigger_id (what views.open needs).
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

// (Re)publish the Home tab for one user, on app_home_opened.
function publishHome(env: Env, userId: string): Promise<void> {
	return slackApiWarn(env, "views.publish", { user_id: userId, view: homeView() });
}

// ---------------------------------------------------------------------------
// view_submission value extraction
// ---------------------------------------------------------------------------

type ViewState = {
	values?: Record<
		string,
		Record<string, { value?: unknown; selected_date?: unknown; selected_time?: unknown; selected_option?: { value?: unknown } }>
	>;
};

// Trimmed, length-capped string; undefined when absent or blank.
function readText(state: ViewState, block: string, action: string, cap: number): string | undefined {
	const raw = state.values?.[block]?.[action]?.value;
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	// Don't let the cap split a surrogate pair (e.g. mid-emoji).
	const capped = trimmed.slice(0, cap);
	const last = capped.charCodeAt(capped.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? capped.slice(0, -1) : capped;
}

// The date/time pickers return naive strings ("YYYY-MM-DD" / "HH:mm") with no
// timezone attached; the submission handler reads them as SPACE_TIMEZONE
// wall-clock, matching the timezone named in the modal's labels.
function readDate(state: ViewState, block: string, action: string): string | undefined {
	const raw = state.values?.[block]?.[action]?.selected_date;
	return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

function readTime(state: ViewState, block: string, action: string): string | undefined {
	const raw = state.values?.[block]?.[action]?.selected_time;
	return typeof raw === "string" && /^\d{2}:\d{2}$/.test(raw) ? raw : undefined;
}

// The repeat select always carries a value (it has an initial_option), but a
// crafted payload may not; anything unrecognized reads as "none".
function readRepeat(state: ViewState, block: string, action: string): RepeatKey {
	const raw = state.values?.[block]?.[action]?.selected_option?.value;
	return typeof raw === "string" && raw in REPEATS ? (raw as RepeatKey) : "none";
}

// Past-arrival grace ("now" rounds down to the minute; slow submits). Older is
// rejected inline; the /my lookup used for confirmation only sees upcoming visits.
const ARRIVAL_GRACE_S = 120;

// ---------------------------------------------------------------------------
// Repeat expansion
// ---------------------------------------------------------------------------
//
// Calendar math over naive "YYYY-MM-DD" strings is timezone-free, so the
// series is expanded in date space and only the final date+time wall-clocks
// are converted to instants (per occurrence, so DST changes mid-series keep
// the space-local time).

function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

function isWeekend(date: string): boolean {
	const day = new Date(`${date}T00:00:00Z`).getUTCDay();
	return day === 0 || day === 6;
}

// Expand the repeat selection into visit dates (first date included, ascending)
// or an inline field error. `until` is inclusive; ISO date strings compare
// correctly as strings.
function expandRepeat(
	firstDate: string,
	repeat: RepeatKey,
	until: string | undefined,
): { dates: string[] } | { errorBlock: string; error: string } {
	if (repeat === "none") return { dates: [firstDate] };
	if (!until) {
		return { errorBlock: FIELDS.repeatUntil.block, error: "Pick the last visit date for the repeat." };
	}
	if (until < firstDate) {
		return { errorBlock: FIELDS.repeatUntil.block, error: "The repeat ends before the first visit — pick a later date." };
	}
	if (repeat === "weekdays" && isWeekend(firstDate)) {
		return { errorBlock: FIELDS.repeat.block, error: "The first visit falls on a weekend — pick a weekday arrival date to repeat on weekdays." };
	}
	const dates: string[] = [];
	for (let date = firstDate; date <= until; date = addDays(date, REPEATS[repeat].stepDays)) {
		if (repeat === "weekdays" && isWeekend(date)) continue;
		dates.push(date);
		if (dates.length > MAX_VISITS) {
			return { errorBlock: FIELDS.repeatUntil.block, error: `That's more than ${MAX_VISITS} visits — pick an earlier end date.` };
		}
	}
	return { dates };
}

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
async function nexudusContact(env: Env): Promise<string> {
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

// Inverse of toWallClock: naive "YYYY-MM-DDTHH:mm:ss" read as `timeZone`
// wall-clock → epoch seconds. Start from the UTC reading, then correct by the
// round-trip error; the second pass settles values near a DST transition. A
// wall-clock skipped by spring-forward resolves to a nearby real instant.
function fromWallClock(wallClock: string, timeZone: string): number {
	const target = Date.parse(`${wallClock}Z`) / 1000;
	let epoch = target;
	for (let i = 0; i < 2; i++) {
		epoch += target - Date.parse(`${toWallClock(epoch, timeZone)}Z`) / 1000;
	}
	return epoch;
}

// mrkdwn arrival line, space-local and minute-granular (like the modal pickers),
// e.g. "*Arrival:* 2026-07-20 15:30 (Europe/London)".
function arrivalLine(env: Env, epochSeconds: number): string {
	const local = toWallClock(epochSeconds, env.SPACE_TIMEZONE).replace("T", " ").slice(0, 16);
	return `*Arrival:* ${local} (${env.SPACE_TIMEZONE})`;
}

interface VisitorInput {
	fullName?: string;
	email?: string;
	phone?: string;
	arrivalEpochs?: number[]; // ascending; single-element when not repeating
	repeat?: { label: string; until: string; count: number }; // set when repeating; until is the last visit's date
	host?: string;
	notes?: string;
	submittedBy: string;
}

// mrkdwn summary of what was submitted, shown under every result header (and in
// the channel log). Blank optional fields are omitted; arrival is space-local
// (the first visit when repeating).
function submissionSummary(env: Env, input: VisitorInput): string {
	const lines: string[] = [];
	if (input.fullName) lines.push(`*Name:* ${mrkdwnEscape(input.fullName)}`);
	if (input.email) lines.push(`*Email:* ${mrkdwnEscape(input.email)}`);
	if (input.phone) lines.push(`*Phone:* ${mrkdwnEscape(input.phone)}`);
	if (input.arrivalEpochs?.length) lines.push(arrivalLine(env, input.arrivalEpochs[0]));
	if (input.repeat) {
		const { label, until, count } = input.repeat;
		lines.push(`*Repeats:* ${label} until ${until} (${count} visit${count === 1 ? "" : "s"})`);
	}
	if (input.host) lines.push(`*Visiting:* ${mrkdwnEscape(input.host)}`);
	if (input.notes) lines.push(`*Notes:* ${mrkdwnEscape(input.notes)}`);
	lines.push(`*Submitted by:* ${mrkdwnEscape(input.submittedBy)}`);
	return lines.join("\n");
}

// Top line of the ✅ confirmation; dropped from the 🗑️ message on deletion.
// Nexudus emails a separate invite (with its own PIN/QR) per visit, so the
// series variant says so — otherwise one invite per visit looks like a bug.
const INVITE_NOTE = "_The visitor should receive an invite from the Nexudus platform shortly at the email below._";
const SERIES_INVITE_NOTE = "_The visitor should receive a separate Nexudus invite at the email below for each visit in the series._";

// The delete button's payload: the Nexudus Id(s) captured at registration,
// which the click handler deletes directly (README, delete flow). Single
// visits keep the original `{id}` shape so older messages' buttons still work.
interface DeleteRef {
	id?: number;
	ids?: number[];
}

// Success message blocks: the summary plus a Delete button (with a Slack-side
// confirm dialog) carrying the DeleteRef in its value. A repeating series gets
// one button for the whole series; per-visit deletion stays in the portal.
function successBlocks(text: string, ref: DeleteRef): unknown[] {
	const count = ref.ids?.length ?? 1;
	return [
		{ type: "section", text: { type: "mrkdwn", text } },
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: count > 1 ? `Delete all ${count} registrations` : "Delete registration" },
					style: "danger",
					action_id: DELETE_ACTION,
					value: JSON.stringify(ref),
					confirm: {
						title: { type: "plain_text", text: count > 1 ? "Delete all registrations?" : "Delete this registration?" },
						text: {
							type: "plain_text",
							text: count > 1 ? `All ${count} visits will be removed from Nexudus.` : "The visitor will be removed from Nexudus.",
						},
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

	if (!input.fullName || !input.email || !input.arrivalEpochs?.length) {
		return failed("Full name, email and expected arrival are all required.");
	}
	// Nexudus reads the naive ExpectedArrival as UTC (shown space-local in the
	// portal), so send UTC wall-clock; the summary echoes the space-local time.
	const arrivalUtcs = input.arrivalEpochs.map((epoch) => toWallClock(epoch, "UTC"));

	// All registrations go through one account, so CustomerNotes is reception's
	// only view of who submitted and who the visitor is for.
	const noteLines: string[] = [`Submitted via Slack by ${input.submittedBy}`];
	if (input.host) noteLines.push(`Visiting: ${input.host}`);
	if (input.notes) noteLines.push(input.notes);

	// One visitor object per visit in a single request: this is how the Nexudus
	// API registers a repeating series — there is no recurrence field (README).
	const visitors = arrivalUtcs.map((arrivalUtc) => ({
		BusinessId: Number(env.NEXUDUS_BUSINESS_ID), // config only, never from the request
		FullName: input.fullName,
		Email: input.email,
		PhoneNumber: input.phone,
		ExpectedArrival: arrivalUtc,
		CustomerNotes: noteLines.join("\n"),
	}));
	const body = JSON.stringify(visitors);

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

	// The create returns no Ids (README), so confirm by finding each record in
	// the account's own list, which also yields the Ids the Delete button needs.
	// If any visit can't be found the POST may still have landed (whole or in
	// part), so warn softly (DM only, no channel log) and steer away from a
	// blind retry rather than claim success.
	const ids = await lookupVisitorIds(env, input.email, arrivalUtcs);
	if (ids == null) {
		console.warn("registration unconfirmed; visitor Id lookup left unmatched visits"); // no PII
		return {
			ok: false,
			message:
				`⚠️ *Registration submitted — but not confirmed*\n` +
				`We sent this to the visitor system but couldn't confirm it went through. It may already be registered — before submitting again, please check with ${await nexudusContact(env)} to avoid a duplicate.\n${summary}`,
		};
	}

	const inviteNote = ids.length > 1 ? SERIES_INVITE_NOTE : INVITE_NOTE;
	const idLine = ids.length > 1 ? `*Nexudus IDs:* ${ids.join(", ")}` : `*Nexudus ID:* ${ids[0]}`;
	const message = `✅ *Visitor registered*\n${inviteNote}\n${summary}\n${idLine}`;
	return { ok: true, message, blocks: successBlocks(message, ids.length > 1 ? { ids } : { id: ids[0] }) };
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
async function lookupVisitorIds(env: Env, email: string, arrivalUtcs: string[]): Promise<number[] | null> {
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

// ---------------------------------------------------------------------------
// Deletion (the ✅ message's Delete button)
// ---------------------------------------------------------------------------
//
// The button carries the Nexudus Id captured at registration, so a click is a
// direct DELETE /api/public/visitors/{id}: no lookup, no duplicate ambiguity.

// The 🗑️ confirmation is the clicked ✅ message restyled: header swapped, the
// visitor's own fields struck, invite note dropped. Reusing the message keeps
// the Submitted-by and Nexudus ID lines (and any the list API omits), which is
// safe because delete-by-Id matched this exact record. Empty text yields the
// bare header; unrecognized lines pass through unchanged.
function deletedFromMessage(messageText: string | undefined): string {
	if (!messageText) return "🗑️ *Registration deleted*";
	return messageText
		.split("\n")
		.filter((line) => line !== INVITE_NOTE && line !== SERIES_INVITE_NOTE) // the invite no longer applies
		.map((line) => {
			// Match on the header text, not the leading ✅: Slack fully qualifies the
			// emoji on round-trip (appends a variation selector), so === would miss.
			if (line.includes("*Visitor registered*")) return "🗑️ *Registration deleted*";
			return /^\*(Name|Email|Phone|Arrival|Repeats|Visiting|Notes):\*/.test(line) ? `~${line}~` : line;
		})
		.join("\n");
}

// Pause between batches of series deletes; mutable so tests can shrink it.
export const deletePause = { ms: 5000, batch: 8 };

// Delete the registration(s) by Id and return the member-facing outcome. Never
// throws; the clicker always gets feedback. Deletes run in sequence, pausing
// between batches: the public API allows 10 requests / 5 s and a token refresh
// can add a call, so a full 30-visit series must not fire at once. messageText
// is the clicked ✅ message, restyled into the 🗑️ confirmation
// (see deletedFromMessage).
async function deleteVisitors(env: Env, ids: number[], messageText?: string): Promise<{ ok: boolean; text: string }> {
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
	if (failed === 0 && missing === 0) return { ok: true, text: deletedFromMessage(messageText) };

	// Failure contact is the Nexudus account email (see nexudusContact), not
	// the portal, since members can't see these registrations in their own login.
	const contact = await nexudusContact(env);
	if (failed > 0) {
		const done = ids.length - missing - failed;
		const text =
			ids.length === 1
				? `⚠️ Deleting failed — please contact ${contact} to remove the visitor.`
				: `⚠️ Deleted ${done} of ${ids.length} registrations — the rest couldn't be deleted. Please contact ${contact} to remove them.`;
		return { ok: false, text };
	}
	if (missing === ids.length) {
		const text =
			ids.length === 1
				? `⚠️ Couldn't find this registration — it may already be deleted. If it still needs removing, contact ${contact}.`
				: `⚠️ Couldn't find these registrations — they may already be deleted. If they still need removing, contact ${contact}.`;
		return { ok: false, text };
	}
	// Some visits deleted, the rest already gone: the series is fully removed
	// either way, so confirm with a note rather than warn.
	return {
		ok: true,
		text: `${deletedFromMessage(messageText)}\n_${missing} of the ${ids.length} visits couldn't be found — they may already have been deleted._`,
	};
}

type SlackMessage = { text?: string; blocks?: unknown[] };

// The clicked message's content, from its first section block: verbatim mrkdwn,
// newlines intact. message.text is only the notification fallback (newlines
// collapsed), so it can't be restyled line by line; used only if blocks absent.
function messageSectionText(message?: SlackMessage): string | undefined {
	for (const block of message?.blocks ?? []) {
		const section = block as { type?: string; text?: { text?: unknown } };
		if (section.type === "section" && typeof section.text?.text === "string") return section.text.text;
	}
	return message?.text;
}

// Handle a Delete click: delete in Nexudus, then report via the clicked
// message's response_url. On success replace it with the restyled section
// (Delete button dropped), on failure send the clicker an ephemeral note.
async function handleDeleteClick(env: Env, ids: number[], responseUrl: string, message?: SlackMessage): Promise<void> {
	const { ok, text } = await deleteVisitors(env, ids, messageSectionText(message));
	try {
		const body = ok
			? { replace_original: true, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] }
			: { replace_original: false, response_type: "ephemeral", text };
		const res = await fetch(responseUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
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

// A JSON 200, the shape Slack's interactivity endpoint expects for a
// response_action (here, updating the modal in place on submission).
function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path !== "/slack/command" && path !== "/slack/interactivity" && path !== "/slack/events") {
			return new Response("Not found", { status: 404 });
		}
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		// Per-IP rate limit, checked before the HMAC work (wrangler.jsonc
		// `ratelimits`). Slack retries a 429ed event, so a burst degrades
		// gracefully. Fails open: losing the limiter must not down the endpoint.
		try {
			const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
			const { success } = await env.RATE_LIMITER.limit({ key: ip });
			if (!success) return new Response("Rate limited", { status: 429 });
		} catch {
			// limiter unavailable, let the request through
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
			// tab === "home" only; the event also fires for the Messages tab.
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
			actions?: Array<{ action_id?: string; value?: string; selected_conversation?: string }>;
			message?: SlackMessage; // present on block_actions from a message (delete-by-Id)
			view?: { id?: string; callback_id?: string; state?: ViewState };
		};
		try {
			payload = JSON.parse(payloadRaw ?? "");
		} catch {
			return new Response("", { status: 200 });
		}

		// Button clicks: the Home tab's "Register a visitor" opens the modal; a
		// confirmation's "Delete registration" removes the visitor again.
		if (payload.type === "block_actions") {
			const clickedOpen = (payload.actions ?? []).some((a) => a.action_id === OPEN_ACTION);
			const clickedDelete = (payload.actions ?? []).find((a) => a.action_id === DELETE_ACTION);
			if (clickedOpen && payload.trigger_id) {
				const { ok, error } = await openModal(env, payload.trigger_id);
				if (!ok) console.warn(`views.open failed: ${error ?? "unknown"}`);
			} else if (clickedDelete?.value && payload.response_url) {
				// Accept the single `{id}` shape (older messages) or a series'
				// `{ids}`; cap the count so a malformed value can't drive an
				// unbounded delete loop.
				let ids: number[] = [];
				try {
					const parsed = JSON.parse(clickedDelete.value) as { id?: unknown; ids?: unknown };
					if (typeof parsed.id === "number") ids = [parsed.id];
					else if (Array.isArray(parsed.ids) && parsed.ids.every((v): v is number => typeof v === "number")) {
						ids = parsed.ids.slice(0, MAX_VISITS);
					}
				} catch {
					// stale or foreign button value, ignore
				}
				if (ids.length) {
					ctx.waitUntil(handleDeleteClick(env, ids, payload.response_url, payload.message));
				}
			}
			return new Response("", { status: 200 });
		}

		if (payload.type !== "view_submission" || payload.view?.callback_id !== CALLBACK_ID) {
			return new Response("", { status: 200 }); // not ours or not a submission, ack and ignore
		}

		const state = payload.view?.state ?? {};
		const userId = payload.user?.id;
		// The pickers are naive and labeled with SPACE_TIMEZONE in the modal, so the
		// combined wall-clock is read in the space's timezone, not the member's.
		const arrivalDate = readDate(state, FIELDS.arrivalDate.block, FIELDS.arrivalDate.action);
		const arrivalTime = readTime(state, FIELDS.arrivalTime.block, FIELDS.arrivalTime.action);
		const repeat = readRepeat(state, FIELDS.repeat.block, FIELDS.repeat.action);
		const repeatUntil = readDate(state, FIELDS.repeatUntil.block, FIELDS.repeatUntil.action);

		// Expand the repeat into visit dates, bouncing bad combinations back onto
		// the repeat fields inline. Skipped when the arrival itself is missing
		// (crafted payload); that falls through to the required-fields failure.
		let arrivalEpochs: number[] | undefined;
		let repeatInfo: VisitorInput["repeat"];
		if (arrivalDate && arrivalTime) {
			const expanded = expandRepeat(arrivalDate, repeat, repeatUntil);
			if ("error" in expanded) {
				return jsonResponse({ response_action: "errors", errors: { [expanded.errorBlock]: expanded.error } });
			}
			arrivalEpochs = expanded.dates.map((date) => fromWallClock(`${date}T${arrivalTime}:00`, env.SPACE_TIMEZONE));
			if (repeat !== "none") {
				// `until` is the last generated visit, not the raw picker value:
				// "every week until Sep 19" may end days earlier.
				const dates = expanded.dates;
				repeatInfo = { label: REPEATS[repeat].label, until: dates[dates.length - 1], count: dates.length };
			}
		}
		const input: VisitorInput = {
			fullName: readText(state, FIELDS.fullName.block, FIELDS.fullName.action, FIELDS.fullName.cap),
			email: readText(state, FIELDS.email.block, FIELDS.email.action, FIELDS.email.cap),
			phone: readText(state, FIELDS.phone.block, FIELDS.phone.action, FIELDS.phone.cap),
			arrivalEpochs,
			repeat: repeatInfo,
			host: readText(state, FIELDS.host.block, FIELDS.host.action, FIELDS.host.cap),
			notes: readText(state, FIELDS.notes.block, FIELDS.notes.action, FIELDS.notes.cap),
			submittedBy: payload.user?.name ?? payload.user?.username ?? "a Slack user",
		};

		// Bounce a past first arrival back onto the time field (ARRIVAL_GRACE_S);
		// the series is ascending, so later visits can't be earlier.
		if (input.arrivalEpochs?.length && input.arrivalEpochs[0] < Date.now() / 1000 - ARRIVAL_GRACE_S) {
			return jsonResponse({
				response_action: "errors",
				errors: {
					[FIELDS.arrivalTime.block]: `This time is in the past (${env.SPACE_TIMEZONE}) — pick when the visitor is expected to arrive.`,
				},
			});
		}

		// Register + notify in the background so we ack within Slack's 3s window.
		// The ack itself swaps the modal for a "⏳ registering" placeholder
		// (response_action:update); the background work then updates that same view
		// to the result. The DM remains the durable record if the user closes it.
		if (userId) {
			const viewId = payload.view?.id;
			ctx.waitUntil(
				(async () => {
					// Upgrade the username to the profile's full name when we can.
					input.submittedBy = (await fetchFullName(env, userId)) ?? input.submittedBy;
					const { ok, message, blocks } = await registerVisitor(env, input);
					// Update the open modal first; it's what the submitter is watching.
					if (viewId) await updateStatusModal(env, viewId, message);
					await postMessage(env, userId, message, blocks);
					// Successes also go to the visitors channel, the human-readable
					// log of registrations (VISITOR_CHANNEL; empty disables it).
					// Failures stay in the submitter's DM.
					if (ok && env.VISITOR_CHANNEL) await postMessage(env, env.VISITOR_CHANNEL, message, blocks);
				})(),
			);
			return jsonResponse({ response_action: "update", view: statusModal(registeringText(input.arrivalEpochs?.length ?? 1)) });
		}
		// No user id (shouldn't happen for a real submission), just close the modal.
		return new Response("", { status: 200 });
	},
} satisfies ExportedHandler<Env>;
