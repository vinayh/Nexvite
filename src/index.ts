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

// DM a user by id — chat.postMessage opens the IM when channel is a user id.
async function postDM(env: Env, userId: string, text: string): Promise<void> {
	const { ok, error } = await slackApi(env, "chat.postMessage", { channel: userId, text });
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

// ---------------------------------------------------------------------------
// Nexudus registration
// ---------------------------------------------------------------------------

// Epoch seconds → "YYYY-MM-DDTHH:mm:ss" wall-clock in the space's timezone —
// no trailing Z/offset, because Nexudus stores wall-clock local time.
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

// Returns the message to show the submitter (✅ or ❌). Never throws.
async function registerVisitor(env: Env, input: VisitorInput): Promise<string> {
	if (!input.fullName || !input.email || input.arrivalEpoch == null) {
		return "❌ Registration failed: full name, email and expected arrival are all required.";
	}
	const arrival = toWallClock(input.arrivalEpoch, env.SPACE_TIMEZONE);

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
		ExpectedArrival: arrival,
		CustomerNotes: noteLines.join("\n"),
	};
	const body = JSON.stringify([visitor]); // body is an array of visitors

	const createVisitor = (accessToken: string) =>
		fetch(`${base}/api/public/visitors`, {
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
			body,
		});

	const tokens = await readTokens(env);
	let regRes = await createVisitor(tokens.access_token);

	// Access token expired → refresh (rotates the pair), persist, and retry once.
	if (regRes.status === 401) {
		const refreshed = await refreshTokens(env, base, tokens.refresh_token);
		if (!refreshed) {
			return "❌ Registration failed: the Nexudus session expired and couldn't be renewed. An admin needs to re-seed the tokens (scripts/nexudus-token.sh).";
		}
		await env.TOKENS.put(TOKEN_KEY, JSON.stringify(refreshed));
		regRes = await createVisitor(refreshed.access_token);
	}

	if (!regRes.ok) {
		const detail = (await regRes.text().catch(() => "")).slice(0, 300);
		return `❌ Nexudus rejected the registration: ${detail || `HTTP ${regRes.status}`}`;
	}

	return `✅ Registered ${input.fullName}, expected ${arrival.replace("T", " ")} (${env.SPACE_TIMEZONE}).`;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type SlackUser = { id?: string; name?: string; username?: string };

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path !== "/slack/command" && path !== "/slack/interactivity") {
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
			const form = new URLSearchParams(rawBody);
			const triggerId = form.get("trigger_id");
			if (!triggerId) return new Response("", { status: 200 });

			const { ok, error } = await slackApi(env, "views.open", {
				trigger_id: triggerId,
				view: visitorModal(),
			});
			if (!ok) {
				console.log(`views.open failed: ${error ?? "unknown"}`);
				return new Response("Couldn't open the visitor form — please try again.", { status: 200 });
			}
			return new Response("", { status: 200 });
		}

		// path === "/slack/interactivity"
		const payloadRaw = new URLSearchParams(rawBody).get("payload");
		let payload: { type?: string; user?: SlackUser; view?: { callback_id?: string; state?: ViewState } };
		try {
			payload = JSON.parse(payloadRaw ?? "");
		} catch {
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
				registerVisitor(env, input).then((message) => postDM(env, userId, message)),
			);
		}
		return new Response("", { status: 200 });
	},
} satisfies ExportedHandler<Env>;
