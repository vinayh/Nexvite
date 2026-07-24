/**
 * Slack transport: request-signature verification, thin Web API wrappers, and
 * readers for view_submission state values. App-agnostic — nothing here knows
 * about visitors or Nexudus.
 *
 * Never log modal values, tokens, or Slack response bodies; only Slack error
 * codes are safe to log (see the PII rules in src/index.ts).
 */

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
export async function verifySlackSignature(request: Request, rawBody: string, signingSecret: string): Promise<boolean> {
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

// The shared transport: authorized fetch + response parsing. Never throws — a
// Slack network failure must not 500 the endpoint or stop the background
// notify chain (a failed DM should still let the channel log post).
async function slackCall(env: Env, url: string, init: RequestInit): Promise<{ ok: boolean; error?: string; json: unknown }> {
	try {
		const res = await fetch(url, {
			...init,
			headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, ...init.headers },
		});
		const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
		return { ok: Boolean(json?.ok), error: json?.error, json };
	} catch {
		return { ok: false, error: "network_error", json: null };
	}
}

// A JSON-POST Web API method call.
export function slackApi(env: Env, method: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
	return slackCall(env, `${SLACK_API}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify(body),
	});
}

// A Slack call whose failure is only log-worthy: warn with the error code
// (never PII) and move on, reporting the outcome for callers that care.
export async function slackApiWarn(env: Env, method: string, body: unknown): Promise<boolean> {
	const { ok, error } = await slackApi(env, method, body);
	if (!ok) console.warn(`${method} failed: ${error ?? "unknown"}`);
	return ok;
}

// Post a message. `channel` may be a user id (chat.postMessage opens the IM)
// or a channel id / #name (the bot must be a member of the channel). `blocks`
// is optional Block Kit; `text` remains the notification fallback.
export async function postMessage(env: Env, channel: string, text: string, blocks?: unknown[]): Promise<void> {
	await slackApiWarn(env, "chat.postMessage", { channel, text, ...(blocks && { blocks }) });
}

// The interactivity payload only carries the submitter's username; the
// profile's full name needs a users.info lookup (scope: users:read, GET
// unlike the POST methods). Returns null on any failure so the caller can
// fall back to the username.
export async function fetchFullName(env: Env, userId: string): Promise<string | null> {
	const { ok, error, json } = await slackCall(env, `${SLACK_API}/users.info?user=${encodeURIComponent(userId)}`, {});
	if (!ok) {
		console.warn(`users.info failed: ${error ?? "unknown"}`); // error code only, no PII
		return null;
	}
	const { user } = json as { user?: { real_name?: string; profile?: { real_name?: string } } };
	return user?.profile?.real_name || user?.real_name || null;
}

// Post a report back through a clicked message's response_url; failures are
// only log-worthy (the action itself already happened or didn't).
export async function respond(responseUrl: string, body: unknown): Promise<void> {
	try {
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

// Member-provided text goes into mrkdwn messages (DM + channel log); escape
// Slack's control characters so a visitor name/note can't smuggle in a
// mention like <!channel>. https://docs.slack.dev/messaging/formatting-message-text
export function mrkdwnEscape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A message as block_actions delivers it: the verbatim blocks plus the plain
// notification-fallback text.
export type SlackMessage = { text?: string; blocks?: unknown[] };

// ---------------------------------------------------------------------------
// view_submission value extraction
// ---------------------------------------------------------------------------

export type ViewState = {
	values?: Record<
		string,
		Record<
			string,
			{
				value?: unknown;
				selected_date?: unknown;
				selected_time?: unknown;
				selected_options?: Array<{ value?: unknown }>;
			}
		>
	>;
};

// Where a value lives in view.state.values, as the caller's field table
// declares it (e.g. FIELDS in src/messages.ts).
export interface FieldRef {
	block: string;
	action: string;
}

function fieldValue(state: ViewState, field: FieldRef) {
	return state.values?.[field.block]?.[field.action];
}

// Trimmed, length-capped string; undefined when absent or blank.
export function readText(state: ViewState, field: FieldRef & { cap: number }): string | undefined {
	const raw = fieldValue(state, field)?.value;
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	// Don't let the cap split a surrogate pair (e.g. mid-emoji).
	const capped = trimmed.slice(0, field.cap);
	const last = capped.charCodeAt(capped.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? capped.slice(0, -1) : capped;
}

// The date/time pickers return naive strings ("YYYY-MM-DD" / "HH:mm") with no
// timezone attached; the submission handler reads them as SPACE_TIMEZONE
// wall-clock, matching the timezone named in the modal's labels.
export function readDate(state: ViewState, field: FieldRef): string | undefined {
	const raw = fieldValue(state, field)?.selected_date;
	return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

export function readTime(state: ViewState, field: FieldRef): string | undefined {
	const raw = fieldValue(state, field)?.selected_time;
	return typeof raw === "string" && /^\d{2}:\d{2}$/.test(raw) ? raw : undefined;
}

// A number_input's value as a non-negative integer; undefined when absent,
// blank, or (crafted payload) not a plain digit string.
export function readNumber(state: ViewState, field: FieldRef): number | undefined {
	const raw = fieldValue(state, field)?.value;
	return typeof raw === "string" && /^\d{1,7}$/.test(raw) ? Number(raw) : undefined;
}

// A multi-select's (or checkboxes') selected values (string ones only,
// dropping crafted shapes); undefined when the block is absent from the state.
export function readMultiSelect(state: ViewState, field: FieldRef): string[] | undefined {
	const raw = fieldValue(state, field)?.selected_options;
	if (!Array.isArray(raw)) return undefined;
	return raw.map((o) => o?.value).filter((v): v is string => typeof v === "string");
}
