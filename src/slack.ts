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

// Never throws: a Slack network failure must not 500 the endpoint or stop the
// background notify chain (a failed DM should still let the channel log post).
export async function slackApi(env: Env, method: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
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
export async function slackApiWarn(env: Env, method: string, body: unknown): Promise<void> {
	const { ok, error } = await slackApi(env, method, body);
	if (!ok) console.warn(`${method} failed: ${error ?? "unknown"}`);
}

// Post a message. `channel` may be a user id (chat.postMessage opens the IM)
// or a channel id / #name (the bot must be a member of the channel). `blocks`
// is optional Block Kit; `text` remains the notification fallback.
export function postMessage(env: Env, channel: string, text: string, blocks?: unknown[]): Promise<void> {
	return slackApiWarn(env, "chat.postMessage", { channel, text, ...(blocks && { blocks }) });
}

// The interactivity payload only carries the submitter's username; the
// profile's full name needs a users.info lookup (scope: users:read). Returns
// null on any failure so the caller can fall back to the username.
export async function fetchFullName(env: Env, userId: string): Promise<string | null> {
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
		Record<string, { value?: unknown; selected_date?: unknown; selected_time?: unknown; selected_option?: { value?: unknown } }>
	>;
};

// Trimmed, length-capped string; undefined when absent or blank.
export function readText(state: ViewState, block: string, action: string, cap: number): string | undefined {
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
export function readDate(state: ViewState, block: string, action: string): string | undefined {
	const raw = state.values?.[block]?.[action]?.selected_date;
	return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

export function readTime(state: ViewState, block: string, action: string): string | undefined {
	const raw = state.values?.[block]?.[action]?.selected_time;
	return typeof raw === "string" && /^\d{2}:\d{2}$/.test(raw) ? raw : undefined;
}

// A static_select's selected value; undefined when absent (crafted payload).
export function readSelect(state: ViewState, block: string, action: string): string | undefined {
	const raw = state.values?.[block]?.[action]?.selected_option?.value;
	return typeof raw === "string" ? raw : undefined;
}
