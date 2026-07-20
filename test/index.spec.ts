import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import worker, { TOKEN_KEY, CHANNEL_KEY } from "../src/index";

const SIGNING_SECRET = "test-signing-secret";

const testEnv = {
	...env,
	SLACK_SIGNING_SECRET: SIGNING_SECRET,
	SLACK_BOT_TOKEN: "xoxb-test",
} satisfies Env;

// The seeded KV auth record the Nexudus-touching tests start from.
const AUTH = { username: "svc@example.com", access_token: "kv-access", refresh_token: "kv-refresh" };
const seed = () => env.TOKENS.put(TOKEN_KEY, JSON.stringify(AUTH));

const NEXUDUS_BASE = `https://${env.NEXUDUS_SUBDOMAIN}.spaces.nexudus.com`;
const SLACK_BASE = "https://slack.com";

// 2026-07-20 14:30:00 UTC → 15:30 in Europe/London (BST, UTC+1).
const ARRIVAL_EPOCH = Date.UTC(2026, 6, 20, 14, 30, 0) / 1000;
const ARRIVAL_UTC = "2026-07-20T14:30:00"; // sent to Nexudus (naive UTC)
const ARRIVAL_LOCAL = "2026-07-20 15:30"; // shown in messages (Europe/London, BST)

// What the default submissionBody() produces as a success message.
const SUCCESS_TEXT = [
	"✅ *Visitor registered*",
	"_The visitor should receive an invite from the Nexudus platform shortly at the email below._",
	"*Name:* Jane Doe",
	"*Email:* jane.doe@gmail.com",
	"*Phone:* +44 7700 900123",
	`*Arrival:* ${ARRIVAL_LOCAL} (Europe/London)`,
	"*Visiting:* Sam",
	"*Notes:* Needs step-free access",
	"*Submitted by:* Vinay Hiremath",
].join("\n");

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(async () => {
	fetchMock.assertNoPendingInterceptors();
	await env.TOKENS.delete(TOKEN_KEY); // isolate KV state between tests
	await env.TOKENS.delete(CHANNEL_KEY); // …including the admin-set log channel
});

// --- Slack signing helpers (mirror the Worker) -----------------------------

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(rawBody: string, timestamp: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
	return `v0=${hex(mac)}`;
}

let nextIp = 1; // unique per request so tests don't trip the per-IP rate limiter

async function slackRequest(
	path: string,
	rawBody: string,
	opts: { timestamp?: number; signature?: string; omitSignature?: boolean; ip?: string } = {},
): Promise<Request<unknown, IncomingRequestCfProperties>> {
	const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		"X-Slack-Request-Timestamp": ts,
		"CF-Connecting-IP": opts.ip ?? `10.0.${(nextIp >> 8) & 255}.${nextIp++ & 255}`,
	};
	if (!opts.omitSignature) {
		headers["X-Slack-Signature"] = opts.signature ?? (await sign(rawBody, ts));
	}
	return new IncomingRequest(`https://worker.example${path}`, { method: "POST", headers, body: rawBody });
}

async function run(request: Request<unknown, IncomingRequestCfProperties>, envOverride: Env = testEnv): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, envOverride, ctx);
	await waitOnExecutionContext(ctx); // settle ctx.waitUntil() background work
	return response;
}

// --- Payload builders ------------------------------------------------------

const COMMAND_BODY = new URLSearchParams({
	command: "/visitor",
	trigger_id: "trigger-123",
	user_id: "U1",
	user_name: "vinay",
}).toString();

function submissionBody(values?: Record<string, unknown>, over: { type?: string; callback_id?: string; viewId?: string } = {}): string {
	const defaults = {
		full_name: { value: { type: "plain_text_input", value: "Jane Doe" } },
		email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
		phone: { value: { type: "plain_text_input", value: "+44 7700 900123" } },
		arrival: { value: { type: "datetimepicker", selected_date_time: ARRIVAL_EPOCH } },
		host: { value: { type: "plain_text_input", value: "Sam" } },
		notes: { value: { type: "plain_text_input", value: "Needs step-free access" } },
	};
	const payload = {
		type: over.type ?? "view_submission",
		user: { id: "U1", name: "vinay" }, // `name` is the *username*; the full name comes from users.info
		view: {
			// `id` is present on a real submission; omit it to model the modal
			// already being gone (then no views.update is attempted).
			...(over.viewId ? { id: over.viewId } : {}),
			callback_id: over.callback_id ?? "visitor_registration",
			state: { values: values ?? defaults },
		},
	};
	return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function blockActionsBody(
	actionId = "open_visitor_form",
	triggerId = "trig-xyz",
	extra: {
		value?: string;
		responseUrl?: string;
		selectedConversation?: string;
		userId?: string;
		messageText?: string;
	} = {},
): string {
	const payload = {
		type: "block_actions",
		user: { id: extra.userId ?? "U1", name: "Vinay Hiremath" },
		trigger_id: triggerId,
		actions: [
			{
				action_id: actionId,
				...(extra.value ? { value: extra.value } : {}),
				...(extra.selectedConversation ? { selected_conversation: extra.selectedConversation } : {}),
			},
		],
		...(extra.responseUrl ? { response_url: extra.responseUrl } : {}),
		// As Slack delivers it: verbatim content in `blocks`, and a `text` fallback
		// with newlines collapsed to spaces (restyling that is the bug guarded here).
		...(extra.messageText != null
			? {
					message: {
						text: extra.messageText.replace(/\n/g, " "),
						blocks: [
							{ type: "section", text: { type: "mrkdwn", text: extra.messageText } },
							{ type: "actions", elements: [{ type: "button", action_id: "delete_visitor" }] },
						],
					},
				}
			: {}),
	};
	return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

// --- Mocks -----------------------------------------------------------------

function headerGet(headers: unknown, name: string): string | undefined {
	if (!headers) return undefined;
	const h = headers as { get?: (n: string) => string | null } & Record<string, string>;
	if (typeof h.get === "function") return h.get(name) ?? undefined;
	const lower = name.toLowerCase();
	for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
	return undefined;
}

// users.info lookup — used for the submitter's full name and for the admin
// check (is_admin/is_owner). GET, unlike the POST methods.
function mockUserInfo(reply: object = { ok: true, user: { profile: { real_name: "Vinay Hiremath" } } }, user = "U1") {
	fetchMock.get(SLACK_BASE).intercept({ path: "/api/users.info", method: "GET", query: { user } }).reply(200, JSON.stringify(reply));
}

function mockSlack(method: string, capture?: (body: any) => void, reply: object = { ok: true }) {
	fetchMock
		.get(SLACK_BASE)
		.intercept({ path: `/api/${method}`, method: "POST" })
		.reply((opts) => {
			if (capture) capture(JSON.parse(opts.body as string));
			return { statusCode: 200, data: JSON.stringify(reply) };
		});
}

type Captured = { body?: string; auth?: string; clientId?: string };

function mockVisitors(capture?: (c: Captured) => void, status = 200, data = "") {
	fetchMock
		.get(NEXUDUS_BASE)
		.intercept({ path: "/api/public/visitors", method: "POST" })
		.reply((opts) => {
			if (capture) capture({ body: opts.body as string, auth: headerGet(opts.headers, "authorization") });
			return { statusCode: status, data };
		});
}

// GET /api/public/visitors/my?showUpcoming=true — the account's own upcoming
// registrations (the only Nexudus read route). Each call registers one reply,
// consumed in order, so multiple calls model successive lookups (e.g. a retry).
function mockMyList(records: unknown[]) {
	fetchMock
		.get(NEXUDUS_BASE)
		.intercept({ path: "/api/public/visitors/my", method: "GET", query: { showUpcoming: "true" } })
		.reply(200, JSON.stringify({ Records: records }));
}

function mockRefresh(
	capture?: (c: Captured) => void,
	status = 200,
	reply: object = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 1209599 },
) {
	fetchMock
		.get(NEXUDUS_BASE)
		.intercept({ path: "/api/token", method: "POST" })
		.reply((opts) => {
			if (capture) capture({ body: opts.body as string, clientId: headerGet(opts.headers, "client_id") });
			return { statusCode: status, data: status === 200 ? JSON.stringify(reply) : "bad_grant" };
		});
}

// ---------------------------------------------------------------------------

describe("routing", () => {
	it("returns 404 for an unknown path", async () => {
		const res = await run(await slackRequest("/nope", COMMAND_BODY));
		expect(res.status).toBe(404);
	});

	it("returns 405 for a non-POST method", async () => {
		const req = new IncomingRequest("https://worker.example/slack/command", { method: "GET" });
		const res = await run(req);
		expect(res.status).toBe(405);
	});
});

describe("rate limiting", () => {
	it("throttles a single IP with 429 once the per-minute limit is exceeded", async () => {
		// Limit is 20/min (wrangler.jsonc ratelimits). Unsigned requests suffice —
		// the limiter runs before signature verification, so the first 20 get 401
		// and the 21st is cut off with 429 (no outbound calls either way).
		const statuses: number[] = [];
		for (let i = 0; i < 21; i++) {
			const res = await run(await slackRequest("/slack/command", COMMAND_BODY, { omitSignature: true, ip: "203.0.113.9" }));
			statuses.push(res.status);
		}
		expect(statuses[0]).toBe(401);
		expect(statuses[20]).toBe(429);
	});

	it("fails open (request still handled) when the limiter itself errors", async () => {
		let viewsOpen: any;
		mockSlack("views.open", (b) => (viewsOpen = b));

		const broken: Env = {
			...testEnv,
			RATE_LIMITER: { limit: () => Promise.reject(new Error("limiter down")) } as RateLimit,
		};
		const res = await run(await slackRequest("/slack/command", COMMAND_BODY), broken);
		expect(res.status).toBe(200); // not 500, not 429 — the request went through
		expect(viewsOpen.trigger_id).toBe("trigger-123");
	});
});

describe("signature verification", () => {
	it("rejects a request with no signature header (401)", async () => {
		const res = await run(await slackRequest("/slack/command", COMMAND_BODY, { omitSignature: true }));
		expect(res.status).toBe(401);
	});

	it("rejects a bad signature (401)", async () => {
		const res = await run(await slackRequest("/slack/command", COMMAND_BODY, { signature: "v0=deadbeef" }));
		expect(res.status).toBe(401);
	});

	it("rejects a stale timestamp even with a valid signature (401)", async () => {
		const old = Math.floor(Date.now() / 1000) - 60 * 10; // 10 minutes ago
		const res = await run(await slackRequest("/slack/command", COMMAND_BODY, { timestamp: old }));
		expect(res.status).toBe(401);
	});
});

describe("slash command → open modal", () => {
	it("opens the visitor modal with the trigger_id and acks 200", async () => {
		let viewsOpen: any;
		mockSlack("views.open", (b) => (viewsOpen = b));

		const res = await run(await slackRequest("/slack/command", COMMAND_BODY));
		expect(res.status).toBe(200);
		expect(viewsOpen.trigger_id).toBe("trigger-123");
		expect(viewsOpen.view.callback_id).toBe("visitor_registration");
		const blockIds = viewsOpen.view.blocks.map((b: any) => b.block_id);
		expect(blockIds).toEqual(["full_name", "email", "phone", "arrival", "host", "notes"]);
	});

	it("tells the user to retry if views.open fails, still 200", async () => {
		mockSlack("views.open", undefined, { ok: false, error: "expired_trigger_id" });
		const res = await run(await slackRequest("/slack/command", COMMAND_BODY));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Couldn't open");
	});
});

describe("view_submission → register + DM", () => {
	beforeEach(seed);

	it("registers with the KV access token, DMs success with the looked-up Nexudus Id, and logs to the channel", async () => {
		let visitor: Captured | undefined;
		const posts: any[] = [];
		mockUserInfo();
		mockVisitors((c) => (visitor = c), 200, JSON.stringify([{ Id: 1 }])); // create returns no usable Id
		// The Id comes from the follow-up /my lookup (42 ≠ the create-body's 1),
		// matched on email + the arrival exactly as sent.
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC }]);
		mockSlack("chat.postMessage", (b) => posts.push(b)); // DM to the submitter
		mockSlack("chat.postMessage", (b) => posts.push(b)); // channel log

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		// The ack swaps the modal for the "⏳ registering" placeholder in place.
		const ack = JSON.parse(await res.text());
		expect(ack.response_action).toBe("update");
		expect(ack.view.blocks[0].text.text).toContain("Registering your visitor");

		// Used the KV access token; no refresh happened, the record is unchanged.
		expect(visitor?.auth).toBe("Bearer kv-access");
		expect(JSON.parse((await env.TOKENS.get(TOKEN_KEY))!)).toEqual(AUTH);

		const body = JSON.parse(visitor!.body!);
		expect(body).toHaveLength(1);
		expect(body[0].BusinessId).toBe(Number(env.NEXUDUS_BUSINESS_ID));
		expect(body[0].FullName).toBe("Jane Doe");
		expect(body[0].Email).toBe("jane.doe@gmail.com");
		expect(body[0].PhoneNumber).toBe("+44 7700 900123");
		expect(body[0].ExpectedArrival).toBe(ARRIVAL_UTC); // UTC, not space-local
		expect(body[0].CustomerNotes).toBe("Submitted via Slack by Vinay Hiremath\nVisiting: Sam\nNeeds step-free access");

		// The message ends with the Nexudus Id line; DM first, then the same
		// summary to the visitors channel.
		const successWithId = `${SUCCESS_TEXT}\n*Nexudus ID:* 42`;
		expect(posts).toHaveLength(2);
		expect(posts[0].channel).toBe("U1");
		expect(posts[0].text).toBe(successWithId);
		expect(posts[1].channel).toBe(env.VISITOR_CHANNEL);
		expect(posts[1].text).toBe(successWithId);

		// Both carry the summary + a Delete button holding just the captured Id.
		for (const post of posts) {
			expect(post.blocks[0].text.text).toBe(successWithId);
			const button = post.blocks.find((b: any) => b.type === "actions").elements[0];
			expect(button.action_id).toBe("delete_visitor");
			expect(JSON.parse(button.value)).toEqual({ id: 42 });
		}
	});

	it("retries the Id lookup once when the record isn't visible yet, then shows it", async () => {
		const posts: any[] = [];
		mockUserInfo();
		mockVisitors(undefined, 200, JSON.stringify([{ Id: 1 }]));
		mockMyList([]); // first lookup: created record not replicated into /my yet
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC }]); // retry: now there
		mockSlack("chat.postMessage", (b) => posts.push(b)); // DM
		mockSlack("chat.postMessage", (b) => posts.push(b)); // channel log

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(posts[0].text).toBe(`${SUCCESS_TEXT}\n*Nexudus ID:* 42`);
		expect(JSON.parse(posts[0].blocks.find((b: any) => b.type === "actions").elements[0].value)).toEqual({ id: 42 });
	});

	it("DMs a soft warning (nothing to the channel) when the registration can't be confirmed in the visitor system", async () => {
		let dm: any;
		mockUserInfo();
		mockVisitors(undefined, 200, JSON.stringify([{ Id: 1 }]));
		// The create returned 200 but the record never appears in /my (even after the
		// retry). The POST may still have gone through, so warn softly (DM only, no
		// channel log) and steer away from a blind retry rather than cry failure.
		mockMyList([]); // first lookup: not there
		mockMyList([]); // retry: still not there
		mockSlack("chat.postMessage", (b) => (dm = b)); // DM only — no channel post

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.channel).toBe("U1");
		expect(dm.text).toContain("⚠️ *Registration submitted — but not confirmed*");
		expect(dm.text).toContain("couldn't confirm it went through");
		expect(dm.text).toContain("check with svc@example.com to avoid a duplicate");
		expect(dm.text).not.toContain("❌"); // not framed as an outright failure
		expect(dm.text).toContain("*Name:* Jane Doe"); // still echoes what was submitted
		expect(dm.text).not.toContain("*Nexudus ID:*");
	});

	it("logs a success to the admin-configured channel instead of the default", async () => {
		await env.TOKENS.put(CHANNEL_KEY, "C777"); // an admin picked this channel earlier
		const posts: any[] = [];
		mockUserInfo();
		mockVisitors(undefined, 200, JSON.stringify([{ Id: 1 }]));
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC }]);
		mockSlack("chat.postMessage", (b) => posts.push(b)); // DM
		mockSlack("chat.postMessage", (b) => posts.push(b)); // channel log

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(posts[0].channel).toBe("U1"); // DM unchanged
		expect(posts[1].channel).toBe("C777"); // the KV override, not env.VISITOR_CHANNEL
	});

	it("DMs a friendly failure with a generic contact when KV is unseeded (nothing reaches Nexudus)", async () => {
		await env.TOKENS.delete(TOKEN_KEY); // undo the describe-level seed
		let dm: any;
		mockUserInfo();
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.channel).toBe("U1");
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("couldn't connect to the visitor system");
		expect(dm.text).toContain("contact the space team"); // no account email to name
		expect(dm.text).not.toContain("token"); // ops hints stay out of the DM
	});

	it("refreshes on 401, persists the rotated pair to KV, retries, and DMs success", async () => {
		let refresh: Captured | undefined;
		let retried: Captured | undefined;
		const posts: any[] = [];
		mockUserInfo();
		mockVisitors(undefined, 401); // first attempt: access token expired
		mockRefresh((c) => (refresh = c)); // → new-access / new-refresh
		mockVisitors((c) => (retried = c), 200); // retry with the fresh token
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC }]); // Id lookup (new token)
		mockSlack("chat.postMessage", (b) => posts.push(b)); // DM
		mockSlack("chat.postMessage", (b) => posts.push(b)); // channel log

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);

		// Refresh used the KV refresh token + client_id = the account email.
		expect(refresh?.clientId).toBe("svc@example.com");
		expect(refresh?.body).toContain("grant_type=refresh_token");
		expect(refresh?.body).toContain("refresh_token=kv-refresh");

		// Retry used the new access token; KV keeps the username with the new pair.
		expect(retried?.auth).toBe("Bearer new-access");
		expect(JSON.parse((await env.TOKENS.get(TOKEN_KEY))!)).toEqual({
			username: "svc@example.com",
			access_token: "new-access",
			refresh_token: "new-refresh",
		});

		expect(posts[0].text).toBe(`${SUCCESS_TEXT}\n*Nexudus ID:* 42`);
	});

	it("DMs a friendly failure (no jargon) when the refresh itself fails; nothing to the channel", async () => {
		let dm: any;
		mockUserInfo();
		mockVisitors(undefined, 401);
		mockRefresh(undefined, 400); // refresh rejected
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.channel).toBe("U1");
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("couldn't connect to the visitor system");
		expect(dm.text).toContain("contact svc@example.com"); // the Nexudus account, not "an admin"
		expect(dm.text).toContain("*Name:* Jane Doe"); // summary included on failure too
		// The operational hint stays out of the member-facing message.
		expect(dm.text).not.toContain("re-seed");
		expect(dm.text).not.toContain("token");
		expect(dm.text).not.toContain("admin");
		// KV untouched because the refresh failed.
		expect(JSON.parse((await env.TOKENS.get(TOKEN_KEY))!)).toEqual(AUTH);
	});

	it("DMs the friendly failure with the contact email when the network call itself fails", async () => {
		let dm: any;
		mockUserInfo();
		fetchMock.get(NEXUDUS_BASE).intercept({ path: "/api/public/visitors", method: "POST" }).replyWithError(new Error("connection refused"));
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.channel).toBe("U1");
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("couldn't connect to the visitor system");
		expect(dm.text).toContain("contact svc@example.com");
	});

	it("still posts the channel log when the DM fails", async () => {
		const posts: any[] = [];
		mockUserInfo();
		mockVisitors();
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC }]);
		mockSlack("chat.postMessage", (b) => posts.push(b), { ok: false, error: "cannot_dm_user" }); // DM fails
		mockSlack("chat.postMessage", (b) => posts.push(b)); // channel log still goes out

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(posts).toHaveLength(2);
		expect(posts[0].channel).toBe("U1");
		expect(posts[1].channel).toBe(env.VISITOR_CHANNEL);
	});

	it("DMs a friendly failure when the KV record is corrupt (nothing reaches Nexudus)", async () => {
		await env.TOKENS.put(TOKEN_KEY, "not-json");
		let dm: any;
		mockUserInfo();
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("contact the space team");
	});

	it("length-caps member-provided values before they reach Nexudus", async () => {
		let visitor: Captured | undefined;
		mockUserInfo();
		mockVisitors((c) => (visitor = c));
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC }]);
		mockSlack("chat.postMessage"); // DM
		mockSlack("chat.postMessage"); // channel log

		const values = {
			full_name: { value: { type: "plain_text_input", value: "N".repeat(250) } },
			email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
			arrival: { value: { type: "datetimepicker", selected_date_time: ARRIVAL_EPOCH } },
		};
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(visitor!.body!)[0].FullName).toBe("N".repeat(200)); // FIELDS.fullName.cap
	});

	it("DMs the Nexudus rejection detail on a 400; nothing to the channel", async () => {
		let dm: any;
		mockUserInfo();
		mockVisitors(undefined, 400, "Invalid Email Address");
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("Nexudus rejected the registration:");
		expect(dm.text).toContain("Invalid Email Address");
		expect(dm.text).toContain("*Submitted by:* Vinay Hiremath");
	});

	it("DMs a required-fields error and never calls Nexudus when arrival is missing", async () => {
		let dm: any;
		mockUserInfo();
		mockSlack("chat.postMessage", (b) => (dm = b));

		const values = {
			full_name: { value: { type: "plain_text_input", value: "Jane Doe" } },
			email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
			arrival: { value: { type: "datetimepicker", selected_date_time: null } },
		};
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("required");
	});

	it("escapes mrkdwn control characters in member-provided fields (Slack only, not Nexudus)", async () => {
		let visitor: Captured | undefined;
		const posts: any[] = [];
		mockUserInfo();
		mockVisitors((c) => (visitor = c));
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC }]);
		mockSlack("chat.postMessage", (b) => posts.push(b)); // DM
		mockSlack("chat.postMessage", (b) => posts.push(b)); // channel log

		const values = {
			full_name: { value: { type: "plain_text_input", value: "Jane <!channel> & Co" } },
			email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
			arrival: { value: { type: "datetimepicker", selected_date_time: ARRIVAL_EPOCH } },
		};
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);

		// The Slack messages carry the escaped form — no mention injection…
		for (const post of posts) {
			expect(post.text).toContain("*Name:* Jane &lt;!channel&gt; &amp; Co");
			expect(post.text).not.toContain("<!channel>");
		}
		// …while Nexudus receives the text as typed.
		expect(JSON.parse(visitor!.body!)[0].FullName).toBe("Jane <!channel> & Co");
	});

	it("falls back to the username when the full-name lookup fails", async () => {
		let visitor: Captured | undefined;
		const posts: any[] = [];
		mockUserInfo({ ok: false, error: "missing_scope" });
		mockVisitors((c) => (visitor = c));
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC }]);
		mockSlack("chat.postMessage", (b) => posts.push(b)); // DM
		mockSlack("chat.postMessage", (b) => posts.push(b)); // channel log

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(posts[0].text).toContain("*Submitted by:* vinay");
		expect(JSON.parse(visitor!.body!)[0].CustomerNotes).toContain("Submitted via Slack by vinay");
	});

	it("acks and ignores a submission with a foreign callback_id (no outbound calls)", async () => {
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(undefined, { callback_id: "something_else" })));
		expect(res.status).toBe(200);
	});

	it("updates the open modal with the success result, on the same view id, when the submission carries one", async () => {
		let update: any;
		mockUserInfo();
		mockVisitors(undefined, 200, JSON.stringify([{ Id: 1 }]));
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC }]);
		mockSlack("views.update", (b) => (update = b));
		mockSlack("chat.postMessage"); // DM
		mockSlack("chat.postMessage"); // channel log

		const res = await run(await slackRequest("/slack/interactivity", submissionBody(undefined, { viewId: "V123" })));
		expect(res.status).toBe(200);
		// The ack immediately swaps the modal for the "registering" placeholder…
		expect(JSON.parse(await res.text()).response_action).toBe("update");
		// …then the background work updates that same view to the ✅ result (no
		// Delete button in the modal — that lives on the durable DM/channel message).
		expect(update.view_id).toBe("V123");
		expect(update.view.blocks[0].text.text).toBe(`${SUCCESS_TEXT}\n*Nexudus ID:* 42`);
		expect(JSON.stringify(update.view.blocks)).not.toContain("delete_visitor");
	});

	it("updates the modal with the failure message too", async () => {
		await env.TOKENS.delete(TOKEN_KEY); // undo the describe-level seed → connect failure before Nexudus
		let update: any;
		mockUserInfo();
		mockSlack("views.update", (b) => (update = b));
		mockSlack("chat.postMessage"); // DM only — no channel log on failure

		const res = await run(await slackRequest("/slack/interactivity", submissionBody(undefined, { viewId: "V123" })));
		expect(res.status).toBe(200);
		expect(update.view_id).toBe("V123");
		expect(update.view.blocks[0].text.text).toContain("❌ *Registration failed*");
	});

	it("skips the modal update (still DMs) when the submission carries no view id", async () => {
		const posts: any[] = [];
		mockUserInfo();
		mockVisitors(undefined, 200, JSON.stringify([{ Id: 1 }]));
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC }]);
		// No mockSlack("views.update") — afterEach asserts none was attempted.
		mockSlack("chat.postMessage", (b) => posts.push(b)); // DM
		mockSlack("chat.postMessage", (b) => posts.push(b)); // channel log

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(posts).toHaveLength(2);
	});
});

describe("App Home → button → modal", () => {
	function eventBody(event: Record<string, unknown>): string {
		return JSON.stringify({ type: "event_callback", event });
	}

	it("echoes the url_verification challenge", async () => {
		const body = JSON.stringify({ type: "url_verification", challenge: "chal-123" });
		const res = await run(await slackRequest("/slack/events", body));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("chal-123");
	});

	it("publishes the Home tab with the register button on app_home_opened", async () => {
		let publish: any;
		mockUserInfo(); // a non-admin, non-owner user (no is_admin/is_owner fields)
		mockSlack("views.publish", (b) => (publish = b));

		const res = await run(await slackRequest("/slack/events", eventBody({ type: "app_home_opened", user: "U1", tab: "home" })));
		expect(res.status).toBe(200);
		expect(publish.user_id).toBe("U1");
		expect(publish.view.type).toBe("home");
		const actions = publish.view.blocks.find((b: any) => b.type === "actions");
		expect(actions.elements[0].action_id).toBe("open_visitor_form");
		// A normal member sees no admin settings — the channel picker is absent.
		expect(JSON.stringify(publish.view.blocks)).not.toContain("set_visitor_channel");
	});

	it("ignores app_home_opened for the Messages tab (no outbound calls)", async () => {
		const res = await run(await slackRequest("/slack/events", eventBody({ type: "app_home_opened", user: "U1", tab: "messages" })));
		expect(res.status).toBe(200); // afterEach asserts no views.publish happened
	});

	it("ignores a DM to the bot — the DM entry point is disabled (no outbound calls)", async () => {
		const res = await run(
			await slackRequest("/slack/events", eventBody({ type: "message", channel_type: "im", channel: "D42", user: "U1", text: "hi" })),
		);
		expect(res.status).toBe(200);
	});

	it("opens the modal when the button is clicked (block_actions)", async () => {
		let viewsOpen: any;
		mockSlack("views.open", (b) => (viewsOpen = b));

		const res = await run(await slackRequest("/slack/interactivity", blockActionsBody()));
		expect(res.status).toBe(200);
		expect(viewsOpen.trigger_id).toBe("trig-xyz");
		expect(viewsOpen.view.callback_id).toBe("visitor_registration");
	});

	it("acks and ignores block_actions for an unknown action_id (no outbound calls)", async () => {
		const res = await run(await slackRequest("/slack/interactivity", blockActionsBody("some_other_action")));
		expect(res.status).toBe(200);
	});
});

describe("admin config → log channel", () => {
	function eventBody(event: Record<string, unknown>): string {
		return JSON.stringify({ type: "event_callback", event });
	}

	// The channel picker is a conversations_select rendered as a section accessory.
	function findPicker(view: any): any {
		return view.blocks.find((b: any) => b.accessory?.action_id === "set_visitor_channel")?.accessory;
	}

	async function openHome(user = "U1", envOverride: Env = testEnv): Promise<any> {
		let publish: any;
		mockSlack("views.publish", (b) => (publish = b));
		const res = await run(await slackRequest("/slack/events", eventBody({ type: "app_home_opened", user, tab: "home" })), envOverride);
		expect(res.status).toBe(200);
		return publish;
	}

	it("shows the log-channel picker to a workspace admin, seeded with the default channel", async () => {
		mockUserInfo({ ok: true, user: { is_admin: true } });
		const publish = await openHome();
		const picker = findPicker(publish.view);
		expect(picker?.type).toBe("conversations_select");
		// The default #visitor-requests is a name, not an id → no initial_conversation.
		expect(picker.initial_conversation).toBeUndefined();
		expect(JSON.stringify(publish.view.blocks)).toContain("Currently logging to #visitor-requests");
	});

	it("shows the picker to a workspace owner too", async () => {
		mockUserInfo({ ok: true, user: { is_owner: true } });
		expect(findPicker((await openHome()).view)?.action_id).toBe("set_visitor_channel");
	});

	it("shows the picker to an allowlisted user without any admin lookup", async () => {
		// No mockUserInfo — an ADMIN_USER_IDS match short-circuits the users.info
		// call. (Cast: wrangler types ADMIN_USER_IDS as its "" literal default.)
		const allowlistEnv = { ...testEnv, ADMIN_USER_IDS: "U9, U1 , U2" } as unknown as Env;
		const publish = await openHome("U1", allowlistEnv);
		expect(findPicker(publish.view)?.action_id).toBe("set_visitor_channel");
	});

	it("stores an admin's channel choice and re-publishes with it selected", async () => {
		let publish: any;
		mockUserInfo({ ok: true, user: { is_admin: true } });
		mockSlack("views.publish", (b) => (publish = b));

		const res = await run(
			await slackRequest("/slack/interactivity", blockActionsBody("set_visitor_channel", "trig-set", { selectedConversation: "C999" })),
		);
		expect(res.status).toBe(200);
		// Persisted to KV…
		expect(await env.TOKENS.get(CHANNEL_KEY)).toBe("C999");
		// …and the refreshed Home tab preselects it and mentions it as a channel link.
		const picker = findPicker(publish.view);
		expect(picker.initial_conversation).toBe("C999");
		expect(JSON.stringify(publish.view.blocks)).toContain("<#C999>");
	});

	it("ignores a channel change from a non-admin, non-allowlisted user (KV untouched)", async () => {
		mockUserInfo(); // not an admin/owner
		mockSlack("views.publish"); // the re-publish still happens, just without the picker

		const res = await run(
			await slackRequest("/slack/interactivity", blockActionsBody("set_visitor_channel", "trig-set", { selectedConversation: "C999" })),
		);
		expect(res.status).toBe(200);
		expect(await env.TOKENS.get(CHANNEL_KEY)).toBeNull();
	});
});

describe("delete button → remove visitor", () => {
	const RESPOND_BASE = "https://hooks.slack.test";

	beforeEach(seed);

	function mockDelete(id: number, status = 200) {
		fetchMock
			.get(NEXUDUS_BASE)
			.intercept({ path: `/api/public/visitors/${id}`, method: "DELETE" })
			.reply(status, "");
	}

	function mockRespond(capture: (body: any) => void) {
		fetchMock
			.get(RESPOND_BASE)
			.intercept({ path: "/respond", method: "POST" })
			.reply((opts) => {
				capture(JSON.parse(opts.body as string));
				return { statusCode: 200, data: "ok" };
			});
	}

	// The button carries just the Nexudus Id captured at registration.
	async function clickDeleteById(id: number, messageText: string): Promise<Response> {
		return run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor", "trig-del", {
					value: JSON.stringify({ id }),
					responseUrl: `${RESPOND_BASE}/respond`,
					messageText,
				}),
			),
		);
	}

	it("deletes by the captured Id (no /my lookup) and confirms by restyling the clicked message", async () => {
		// The button carries the exact Nexudus Id, so deletion is a direct DELETE by
		// Id and the 🗑️ confirmation is the ✅ message restyled — the only place the
		// Notes / Submitted-by lines survive (the list API omits them). No mockList:
		// asserting no /my call is made on this path.
		const clicked = SUCCESS_TEXT + "\n*Nexudus ID:* 42"; // exactly what the ✅ posts
		mockDelete(42);
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await clickDeleteById(42, clicked);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
		expect(respond.replace_original).toBe(true);
		// Header swapped, Name/Email/Arrival struck, invite note dropped, the rest
		// verbatim with line breaks intact — sourced from blocks, not the collapsed
		// fallback text (see blockActionsBody).
		const deletedText = [
			"🗑️ *Registration deleted*",
			"~*Name:* Jane Doe~",
			"~*Email:* jane.doe@gmail.com~",
			"*Phone:* +44 7700 900123",
			`~*Arrival:* ${ARRIVAL_LOCAL} (Europe/London)~`,
			"*Visiting:* Sam",
			"*Notes:* Needs step-free access",
			"*Submitted by:* Vinay Hiremath",
			"*Nexudus ID:* 42",
		].join("\n");
		// Replacement renders via blocks (the restyled section), Delete button gone.
		expect(respond.blocks).toHaveLength(1);
		expect(respond.blocks[0].type).toBe("section");
		expect(respond.blocks[0].text.text).toBe(deletedText);
		expect(JSON.stringify(respond.blocks)).not.toContain("delete_visitor"); // button dropped
		expect(respond.text).toBe(deletedText); // notification fallback
		expect(respond.text).not.toContain("receive an invite"); // note gone
	});

	it("reports 'may already be deleted' (ephemeral) when the Id delete 404s", async () => {
		mockDelete(42, 404); // the other copy (DM vs channel) already removed it
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await clickDeleteById(42, "✅ *Visitor registered*\n*Nexudus ID:* 42");
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(false);
		expect(respond.response_type).toBe("ephemeral");
		expect(respond.text).toContain("may already be deleted");
		expect(respond.text).toContain("contact svc@example.com");
	});

	it("reports a delete failure (ephemeral) when the DELETE call errors", async () => {
		mockDelete(42, 500);
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await clickDeleteById(42, "✅ *Visitor registered*\n*Nexudus ID:* 42");
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(false);
		expect(respond.response_type).toBe("ephemeral");
		expect(respond.text).toContain("Deleting failed");
		expect(respond.text).toContain("svc@example.com");
	});

	it("ignores a delete click with a malformed value (no outbound calls)", async () => {
		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor", "trig-del", {
					value: "not-json",
					responseUrl: `${RESPOND_BASE}/respond`,
				}),
			),
		);
		expect(res.status).toBe(200);
	});
});
