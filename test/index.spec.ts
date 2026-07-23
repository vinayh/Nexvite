import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import worker, { TOKEN_KEY, lookupRetry, deletePause } from "../src/index";

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

// The pickers submit naive UK wall-clock: 15:30 on 2030-07-20 is BST (UTC+1),
// so Nexudus gets 14:30 UTC. Must stay in the future: past arrivals are
// rejected inline; summer exercises the offset.
const ARRIVAL_DATE = "2030-07-20";
const ARRIVAL_TIME = "15:30";
const ARRIVAL_UTC = "2030-07-20T14:30:00"; // sent to Nexudus (naive UTC)
const ARRIVAL_LOCAL = "2030-07-20 15:30"; // shown in messages (Europe/London, BST)

// The default submission as /my returns it: the record the Id lookup resolves.
const MY_RECORD = { Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC };

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
	lookupRetry.ms = 0; // don't really sleep between Id-lookup attempts
	deletePause.ms = 0; // …or between series-delete batches
});
afterEach(async () => {
	fetchMock.assertNoPendingInterceptors();
	await env.TOKENS.delete(TOKEN_KEY); // isolate KV state between tests
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
		arrival_date: { value: { type: "datepicker", selected_date: ARRIVAL_DATE } },
		arrival_time: { value: { type: "timepicker", selected_time: ARRIVAL_TIME } },
		repeat: { value: { type: "static_select", selected_option: { value: "none" } } },
		repeat_until: { value: { type: "datepicker", selected_date: null } },
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

function eventBody(event: Record<string, unknown>): string {
	return JSON.stringify({ type: "event_callback", event });
}

function blockActionsBody(
	actionId = "open_visitor_form",
	triggerId = "trig-xyz",
	extra: {
		value?: string;
		blockId?: string;
		responseUrl?: string;
		userId?: string;
		messageText?: string;
		messageBlocks?: unknown[];
	} = {},
): string {
	// As Slack delivers the clicked message: verbatim content in `blocks`, a `text`
	// fallback with newlines collapsed to spaces, and the ✅ (U+2705) fully qualified
	// with a trailing variation selector (U+FE0F). The newline collapse and emoji
	// requalification are what naive restyling trips on; this shape guards both.
	// messageBlocks passes an explicit block list (series messages); messageText
	// models the classic single-section shape.
	let message: object | undefined;
	if (extra.messageBlocks) {
		message = { text: "(fallback)", blocks: extra.messageBlocks };
	} else if (extra.messageText != null) {
		const returned = extra.messageText.replace(/✅/g, "✅️");
		message = {
			text: returned.replace(/\n/g, " "),
			blocks: [
				{ type: "section", text: { type: "mrkdwn", text: returned } },
				{ type: "actions", elements: [{ type: "button", action_id: "delete_visitor" }] },
			],
		};
	}
	const payload = {
		type: "block_actions",
		user: { id: extra.userId ?? "U1", name: "Vinay Hiremath" },
		trigger_id: triggerId,
		actions: [
			{
				action_id: actionId,
				...(extra.blockId ? { block_id: extra.blockId } : {}),
				...(extra.value ? { value: extra.value } : {}),
			},
		],
		...(extra.responseUrl ? { response_url: extra.responseUrl } : {}),
		...(message ? { message } : {}),
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

// users.info lookup for the submitter's full name. GET, unlike the POST methods.
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

// The DM + channel-log chat.postMessage pair, captured in send order (the DM
// is always posted first).
function mockPosts(): any[] {
	const posts: any[] = [];
	mockSlack("chat.postMessage", (b) => posts.push(b)); // DM
	mockSlack("chat.postMessage", (b) => posts.push(b)); // channel log
	return posts;
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

// GET /api/public/visitors/my?showUpcoming=true: the account's own upcoming
// registrations (the only Nexudus read route). Each call registers one reply,
// consumed in order, so multiple calls model successive lookups (e.g. a retry).
function mockMyList(records: unknown[]) {
	fetchMock
		.get(NEXUDUS_BASE)
		.intercept({ path: "/api/public/visitors/my", method: "GET", query: { showUpcoming: "true" } })
		.reply(200, JSON.stringify({ Records: records }));
}

// Raw /my reply, for the response shapes and statuses mockMyList can't model.
function mockMyListRaw(body: string, status = 200) {
	fetchMock
		.get(NEXUDUS_BASE)
		.intercept({ path: "/api/public/visitors/my", method: "GET", query: { showUpcoming: "true" } })
		.reply(status, body);
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

	it("acks malformed JSON on /slack/events with a 200 (no outbound calls)", async () => {
		const res = await run(await slackRequest("/slack/events", "{not json"));
		expect(res.status).toBe(200);
	});

	it("acks a malformed interactivity payload with a 200 (no outbound calls)", async () => {
		const res = await run(await slackRequest("/slack/interactivity", new URLSearchParams({ payload: "{not json" }).toString()));
		expect(res.status).toBe(200);
	});
});

describe("rate limiting", () => {
	it("throttles a single IP with 429 once the per-minute limit is exceeded", async () => {
		// Limit is 20/min (wrangler.jsonc ratelimits). Unsigned requests suffice:
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
		expect(res.status).toBe(200); // not 500 or 429, the request went through
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

describe("slash command -> open modal", () => {
	it("opens the visitor modal with the trigger_id and acks 200", async () => {
		let viewsOpen: any;
		mockSlack("views.open", (b) => (viewsOpen = b));

		const res = await run(await slackRequest("/slack/command", COMMAND_BODY));
		expect(res.status).toBe(200);
		expect(viewsOpen.trigger_id).toBe("trigger-123");
		expect(viewsOpen.view.callback_id).toBe("visitor_registration");
		const blockIds = viewsOpen.view.blocks.map((b: any) => b.block_id);
		expect(blockIds).toEqual(["full_name", "email", "phone", "arrival_date", "arrival_time", "repeat", "repeat_until", "host", "notes"]);
		// The pickers are naive and read as SPACE_TIMEZONE wall-clock, so both
		// arrival fields must name the timezone — a member abroad is not
		// entering their local time.
		const byId = Object.fromEntries(viewsOpen.view.blocks.map((b: any) => [b.block_id, b]));
		expect(byId.arrival_date.label.text).toContain("Europe/London");
		expect(byId.arrival_time.label.text).toContain("Europe/London");
		expect(byId.arrival_time.hint.text).toContain("not your own time zone");
		// Repeat defaults to "none" so the single-visit flow needs no interaction;
		// the until field stays optional and names the timezone like the pickers.
		expect(byId.repeat.element.initial_option.value).toBe("none");
		expect(byId.repeat.element.options.map((o: any) => o.text.text)).toEqual([
			"Does not repeat",
			"Every day",
			"Every weekday (Mon–Fri)",
			"Every week",
			"Every 2 weeks",
		]);
		expect(byId.repeat_until.optional).toBe(true);
		expect(byId.repeat_until.label.text).toContain("Europe/London");
	});

	it("tells the user to retry if views.open fails, still 200", async () => {
		mockSlack("views.open", undefined, { ok: false, error: "expired_trigger_id" });
		const res = await run(await slackRequest("/slack/command", COMMAND_BODY));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Couldn't open");
	});
});

describe("view_submission -> register + DM", () => {
	beforeEach(seed);

	it("registers with the KV access token, DMs success with the looked-up Nexudus Id, and logs to the channel", async () => {
		let visitor: Captured | undefined;
		mockUserInfo();
		mockVisitors((c) => (visitor = c), 200, JSON.stringify([{ Id: 1 }])); // create returns no usable Id
		// The Id comes from the follow-up /my lookup (42 ≠ the create-body's 1),
		// matched on email + the arrival exactly as sent.
		mockMyList([MY_RECORD]);
		const posts = mockPosts();

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
		mockUserInfo();
		mockVisitors(undefined, 200, JSON.stringify([{ Id: 1 }]));
		mockMyList([]); // first lookup: created record not replicated into /my yet
		mockMyList([MY_RECORD]); // retry: now there
		const posts = mockPosts();

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(posts[0].text).toBe(`${SUCCESS_TEXT}\n*Nexudus ID:* 42`);
		expect(JSON.parse(posts[0].blocks.find((b: any) => b.type === "actions").elements[0].value)).toEqual({ id: 42 });
	});

	it("DMs a soft warning (nothing to the channel) when the registration can't be confirmed in the visitor system", async () => {
		let dm: any;
		mockUserInfo();
		mockVisitors(undefined, 200, JSON.stringify([{ Id: 1 }]));
		// The create returned 200 but the record never appears in /my (even after
		// the retry). The POST may still have gone through, so warn softly (DM only,
		// no channel log) and steer away from a blind retry rather than report an
		// outright failure.
		mockMyList([]); // first lookup: not there
		mockMyList([]); // retry: still not there
		mockSlack("chat.postMessage", (b) => (dm = b)); // DM only, no channel post

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
		mockUserInfo();
		mockVisitors(undefined, 401); // first attempt: access token expired
		mockRefresh((c) => (refresh = c)); // → new-access / new-refresh
		mockVisitors((c) => (retried = c), 200); // retry with the fresh token
		mockMyList([MY_RECORD]); // Id lookup (new token)
		const posts = mockPosts();

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
		mockMyList([MY_RECORD]);
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
		mockMyList([MY_RECORD]);
		mockPosts();

		const values = {
			full_name: { value: { type: "plain_text_input", value: "N".repeat(250) } },
			email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
			arrival_date: { value: { type: "datepicker", selected_date: ARRIVAL_DATE } },
			arrival_time: { value: { type: "timepicker", selected_time: ARRIVAL_TIME } },
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

	it("DMs a required-fields error and never calls Nexudus when the arrival time is missing", async () => {
		let dm: any;
		mockUserInfo();
		mockSlack("chat.postMessage", (b) => (dm = b));

		// Date without time: the pair only yields an arrival when both parse.
		const values = {
			full_name: { value: { type: "plain_text_input", value: "Jane Doe" } },
			email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
			arrival_date: { value: { type: "datepicker", selected_date: ARRIVAL_DATE } },
			arrival_time: { value: { type: "timepicker", selected_time: null } },
		};
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("required");
	});

	it("rejects a past arrival with an inline field error (no outbound calls)", async () => {
		const values = {
			full_name: { value: { type: "plain_text_input", value: "Jane Doe" } },
			email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
			arrival_date: { value: { type: "datepicker", selected_date: "2020-01-01" } },
			arrival_time: { value: { type: "timepicker", selected_time: "12:00" } },
		};
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		const ack = JSON.parse(await res.text());
		expect(ack.response_action).toBe("errors");
		expect(ack.errors.arrival_time).toContain("in the past");
	});

	it("escapes mrkdwn control characters in member-provided fields (Slack only, not Nexudus)", async () => {
		let visitor: Captured | undefined;
		mockUserInfo();
		mockVisitors((c) => (visitor = c));
		mockMyList([MY_RECORD]);
		const posts = mockPosts();

		const values = {
			full_name: { value: { type: "plain_text_input", value: "Jane <!channel> & Co" } },
			email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
			arrival_date: { value: { type: "datepicker", selected_date: ARRIVAL_DATE } },
			arrival_time: { value: { type: "timepicker", selected_time: ARRIVAL_TIME } },
		};
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);

		// The Slack messages carry the escaped form, no mention injection…
		for (const post of posts) {
			expect(post.text).toContain("*Name:* Jane &lt;!channel&gt; &amp; Co");
			expect(post.text).not.toContain("<!channel>");
		}
		// …while Nexudus receives the text as typed.
		expect(JSON.parse(visitor!.body!)[0].FullName).toBe("Jane <!channel> & Co");
	});

	it("falls back to the username when the full-name lookup fails", async () => {
		let visitor: Captured | undefined;
		mockUserInfo({ ok: false, error: "missing_scope" });
		mockVisitors((c) => (visitor = c));
		mockMyList([MY_RECORD]);
		const posts = mockPosts();

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
		mockMyList([MY_RECORD]);
		mockSlack("views.update", (b) => (update = b));
		mockPosts();

		const res = await run(await slackRequest("/slack/interactivity", submissionBody(undefined, { viewId: "V123" })));
		expect(res.status).toBe(200);
		// The ack immediately swaps the modal for the "registering" placeholder…
		expect(JSON.parse(await res.text()).response_action).toBe("update");
		// …then the background work updates that same view to the ✅ result (no
		// Delete button in the modal; that lives on the durable DM/channel message).
		expect(update.view_id).toBe("V123");
		expect(update.view.blocks[0].text.text).toBe(`${SUCCESS_TEXT}\n*Nexudus ID:* 42`);
		expect(JSON.stringify(update.view.blocks)).not.toContain("delete_visitor");
	});

	it("updates the modal with the failure message too", async () => {
		await env.TOKENS.delete(TOKEN_KEY); // undo the describe-level seed → connect failure before Nexudus
		let update: any;
		mockUserInfo();
		mockSlack("views.update", (b) => (update = b));
		mockSlack("chat.postMessage"); // DM only, no channel log on failure

		const res = await run(await slackRequest("/slack/interactivity", submissionBody(undefined, { viewId: "V123" })));
		expect(res.status).toBe(200);
		expect(update.view_id).toBe("V123");
		expect(update.view.blocks[0].text.text).toContain("❌ *Registration failed*");
	});

	it("skips the modal update (still DMs) when the submission carries no view id", async () => {
		mockUserInfo();
		mockVisitors(undefined, 200, JSON.stringify([{ Id: 1 }]));
		mockMyList([MY_RECORD]);
		// No mockSlack("views.update"); afterEach asserts none was attempted.
		const posts = mockPosts();

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(posts).toHaveLength(2);
	});

	it("treats a legacy KV pair without a username as unseeded", async () => {
		// Nexroom shares this namespace and predates the {username, ...} shape.
		await env.TOKENS.put(TOKEN_KEY, JSON.stringify({ access_token: "old-access", refresh_token: "old-refresh" }));
		let dm: any;
		mockUserInfo();
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("contact the space team"); // no username to name
	});

	it("treats a refresh 200 with a malformed body as a failure and leaves KV untouched", async () => {
		let dm: any;
		mockUserInfo();
		mockVisitors(undefined, 401);
		mockRefresh(undefined, 200, {}); // 200 but no token pair in the body
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("contact svc@example.com");
		// The good record survives; a garbage pair must never overwrite it.
		expect(JSON.parse((await env.TOKENS.get(TOKEN_KEY))!)).toEqual(AUTH);
	});

	it("DMs the friendly connect failure, not a Nexudus rejection, when a 401 survives the refresh", async () => {
		let dm: any;
		mockUserInfo();
		mockVisitors(undefined, 401); // first attempt: rejected
		mockRefresh(); // refresh succeeds → new pair
		mockVisitors(undefined, 401); // retry still rejected: the auth chain is broken
		mockSlack("chat.postMessage", (b) => (dm = b)); // DM only, no channel log

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("couldn't connect to the visitor system");
		expect(dm.text).not.toContain("Nexudus rejected"); // not misreported as a rejection
		expect(dm.text).not.toContain("HTTP 401"); // no auth detail in the DM
		// The rotated pair still lands in KV; the next attempt starts from it.
		expect(JSON.parse((await env.TOKENS.get(TOKEN_KEY))!)).toEqual({
			username: "svc@example.com",
			access_token: "new-access",
			refresh_token: "new-refresh",
		});
	});

	it("still posts the channel log when the DM fetch itself throws", async () => {
		// The existing DM-failure test mocks an ok:false reply; this one throws.
		const posts: any[] = [];
		mockUserInfo();
		mockVisitors();
		mockMyList([MY_RECORD]);
		fetchMock
			.get(SLACK_BASE)
			.intercept({ path: "/api/chat.postMessage", method: "POST" })
			.replyWithError(new Error("socket hang up")); // DM
		mockSlack("chat.postMessage", (b) => posts.push(b)); // channel log still goes out

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(posts).toHaveLength(1);
		expect(posts[0].channel).toBe(env.VISITOR_CHANNEL);
	});

	it("falls back to the username when the users.info fetch throws", async () => {
		fetchMock
			.get(SLACK_BASE)
			.intercept({ path: "/api/users.info", method: "GET", query: { user: "U1" } })
			.replyWithError(new Error("connection refused"));
		mockVisitors();
		mockMyList([MY_RECORD]);
		const posts = mockPosts();

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(posts[0].text).toContain("*Submitted by:* vinay");
	});

	it("sends a winter arrival without the summer offset (UK wall-clock = UTC on GMT)", async () => {
		let visitor: Captured | undefined;
		mockUserInfo();
		mockVisitors((c) => (visitor = c));
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: "2031-01-20T14:30:00" }]);
		const posts = mockPosts();

		// 14:30 UK time on 2031-01-20 is GMT (UTC+0), so Nexudus gets 14:30 as-is.
		const values = {
			full_name: { value: { type: "plain_text_input", value: "Jane Doe" } },
			email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
			arrival_date: { value: { type: "datepicker", selected_date: "2031-01-20" } },
			arrival_time: { value: { type: "timepicker", selected_time: "14:30" } },
		};
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(visitor!.body!)[0].ExpectedArrival).toBe("2031-01-20T14:30:00");
		expect(posts[0].text).toContain("*Arrival:* 2031-01-20 14:30 (Europe/London)");
	});

	it("drops the dangling half when the length cap splits an emoji", async () => {
		let visitor: Captured | undefined;
		mockUserInfo();
		mockVisitors((c) => (visitor = c));
		mockMyList([MY_RECORD]);
		mockPosts();

		// 199 chars + an emoji (two code units): the 200-char cap lands mid-pair.
		const values = {
			full_name: { value: { type: "plain_text_input", value: "N".repeat(199) + "😀" } },
			email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
			arrival_date: { value: { type: "datepicker", selected_date: ARRIVAL_DATE } },
			arrival_time: { value: { type: "timepicker", selected_time: ARRIVAL_TIME } },
		};
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(visitor!.body!)[0].FullName).toBe("N".repeat(199)); // no lone surrogate
	});
});

describe("repeating visits", () => {
	beforeEach(seed);

	it("expands a weekly repeat into one POST of one visitor per date, DST-correct, and DMs the series result", async () => {
		let visitor: Captured | undefined;
		mockUserInfo();
		mockVisitors((c) => (visitor = c));
		// 2030-10-17/24/31 are Thursdays; BST ends 2030-10-27, so 10:00 UK is
		// 09:00 UTC for the first two visits and 10:00 UTC for the last.
		mockMyList([
			{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-10-17T09:00:00" },
			{ Id: 43, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-10-24T09:00:00" },
			{ Id: 44, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-10-31T10:00:00" },
		]);
		const posts = mockPosts();

		const values = {
			full_name: { value: { type: "plain_text_input", value: "Jane Doe" } },
			email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
			arrival_date: { value: { type: "datepicker", selected_date: "2030-10-17" } },
			arrival_time: { value: { type: "timepicker", selected_time: "10:00" } },
			repeat: { value: { type: "static_select", selected_option: { value: "weekly" } } },
			// A Friday: the last matching Thursday is Oct 31, and the summary must
			// show that real last visit, not the raw picker value.
			repeat_until: { value: { type: "datepicker", selected_date: "2030-11-01" } },
		};
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(await res.text()).view.blocks[0].text.text).toContain("Registering 3 visits");

		const body = JSON.parse(visitor!.body!);
		expect(body.map((v: any) => v.ExpectedArrival)).toEqual(["2030-10-17T09:00:00", "2030-10-24T09:00:00", "2030-10-31T10:00:00"]);
		expect(new Set(body.map((v: any) => v.FullName))).toEqual(new Set(["Jane Doe"])); // only the arrival differs

		expect(posts).toHaveLength(2); // DM + channel log
		expect(posts[0].text).toContain("a separate Nexudus invite at the email below for each visit");
		expect(posts[0].text).toContain("*Arrival:* 2030-10-17 10:00 (Europe/London)");
		expect(posts[0].text).toContain("*Repeats:* Every week until 2030-10-31 (3 visits)");
		// One line per visit in the text fallback…
		expect(posts[0].text).toContain("*Visit 1:* 2030-10-17 10:00 (Europe/London) · Nexudus ID 42");
		expect(posts[0].text).toContain("*Visit 2:* 2030-10-24 10:00 (Europe/London) · Nexudus ID 43");
		expect(posts[0].text).toContain("*Visit 3:* 2030-10-31 10:00 (Europe/London) · Nexudus ID 44");

		// …and in blocks: summary section, one row per visit with its own Delete
		// accessory, then the Delete-all actions block.
		const blocks = posts[0].blocks;
		expect(blocks.map((b: any) => b.type)).toEqual(["section", "section", "section", "section", "actions"]);
		const rows = blocks.slice(1, 4);
		expect(rows.map((b: any) => b.block_id)).toEqual(["visit_42", "visit_43", "visit_44"]);
		expect(rows[1].text.text).toBe("*Visit 2:* 2030-10-24 10:00 (Europe/London) · Nexudus ID 43");
		expect(rows[1].accessory.action_id).toBe("delete_visitor_row");
		expect(JSON.parse(rows[1].accessory.value)).toEqual({ id: 43 });
		const button = blocks[4].elements[0];
		expect(button.action_id).toBe("delete_visitor");
		expect(button.text.text).toBe("Delete all 3 registrations");
		expect(JSON.parse(button.value)).toEqual({ ids: [42, 43, 44] });
	});

	// Inline repeat errors happen before the ack, so no outbound calls at all.
	async function expectInlineError(values: Record<string, unknown>, block: string, fragment: string): Promise<void> {
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		const ack = JSON.parse(await res.text());
		expect(ack.response_action).toBe("errors");
		expect(ack.errors[block]).toContain(fragment);
	}

	const base = {
		full_name: { value: { type: "plain_text_input", value: "Jane Doe" } },
		email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
		arrival_date: { value: { type: "datepicker", selected_date: ARRIVAL_DATE } },
		arrival_time: { value: { type: "timepicker", selected_time: ARRIVAL_TIME } },
	};

	it("rejects a repeat without an end date", async () => {
		await expectInlineError(
			{ ...base, repeat: { value: { type: "static_select", selected_option: { value: "weekly" } } } },
			"repeat_until",
			"Pick the last visit date",
		);
	});

	it("rejects an end date before the first visit", async () => {
		await expectInlineError(
			{
				...base,
				repeat: { value: { type: "static_select", selected_option: { value: "weekly" } } },
				repeat_until: { value: { type: "datepicker", selected_date: "2030-07-19" } },
			},
			"repeat_until",
			"before the first visit",
		);
	});

	it("rejects a series longer than 30 visits, naming the cap", async () => {
		// Daily 2030-07-20 → 2030-08-20 inclusive is 32 visits.
		await expectInlineError(
			{
				...base,
				repeat: { value: { type: "static_select", selected_option: { value: "daily" } } },
				repeat_until: { value: { type: "datepicker", selected_date: "2030-08-20" } },
			},
			"repeat_until",
			"more than 30 visits",
		);
	});

	it("rejects a weekday repeat starting on a weekend", async () => {
		// ARRIVAL_DATE 2030-07-20 is a Saturday.
		await expectInlineError(
			{
				...base,
				repeat: { value: { type: "static_select", selected_option: { value: "weekdays" } } },
				repeat_until: { value: { type: "datepicker", selected_date: "2030-07-25" } },
			},
			"repeat",
			"weekend",
		);
	});

	it("goes unconfirmed when the Id lookup can't resolve every visit in the series", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyList([MY_RECORD]); // first visit only, second unmatched — first lookup
		mockMyList([MY_RECORD]); // retry
		let dm: any;
		mockSlack("chat.postMessage", (b) => (dm = b));

		const values = {
			...base,
			repeat: { value: { type: "static_select", selected_option: { value: "weekly" } } },
			repeat_until: { value: { type: "datepicker", selected_date: "2030-07-27" } },
		};
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("⚠️ *Registration submitted — but not confirmed*");
	});
});

describe("Id lookup -> /my parsing", () => {
	beforeEach(seed);

	// Submit the default form, expect a success DM carrying `id`, return the DM.
	async function submitExpectingId(id: number): Promise<any> {
		const posts = mockPosts();
		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(posts[0].text).toContain(`*Nexudus ID:* ${id}`);
		return posts[0];
	}

	// Submit the default form, expect the soft "not confirmed" DM (no channel log).
	async function submitExpectingUnconfirmed(): Promise<void> {
		let dm: any;
		mockSlack("chat.postMessage", (b) => (dm = b)); // DM only
		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("not confirmed");
	}

	it("resolves the Id from a bare-array /my response", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyListRaw(JSON.stringify([MY_RECORD]));
		await submitExpectingId(42);
	});

	it("resolves the Id from an envelope under a key other than Records", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyListRaw(JSON.stringify({ Items: [MY_RECORD] }));
		await submitExpectingId(42);
	});

	it("treats a /my body with no array anywhere as unconfirmed", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyListRaw(JSON.stringify({ Foo: 1 })); // first lookup
		mockMyListRaw(JSON.stringify({ Foo: 1 })); // retry
		await submitExpectingUnconfirmed();
	});

	it("treats a /my 500 as unconfirmed", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyListRaw("", 500); // first lookup
		mockMyListRaw("", 500); // retry
		await submitExpectingUnconfirmed();
	});

	it("matches a record in the legacy /Date(ms)/ form", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: `/Date(${Date.parse(`${ARRIVAL_UTC}Z`)})/` }]);
		await submitExpectingId(42);
	});

	it("matches an offset-suffixed ISO arrival", async () => {
		mockUserInfo();
		mockVisitors();
		// Same instant as ARRIVAL_UTC, expressed with an explicit +01:00 offset.
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-07-20T15:30:00+01:00" }]);
		await submitExpectingId(42);
	});

	it("prefers UtcExpectedArrival over ExpectedArrival when both parse", async () => {
		mockUserInfo();
		mockVisitors();
		// 99 matches only on the space-local ExpectedArrival; 42 matches on the UTC
		// field. Utc wins whenever it parses, so 99 must be excluded.
		mockMyList([
			{ Id: 99, Email: "jane.doe@gmail.com", UtcExpectedArrival: "2030-07-20T13:30:00", ExpectedArrival: ARRIVAL_UTC },
			{ Id: 42, Email: "jane.doe@gmail.com", UtcExpectedArrival: ARRIVAL_UTC, ExpectedArrival: "2030-07-20T15:30:00" },
		]);
		const dm = await submitExpectingId(42);
		const button = dm.blocks.find((b: any) => b.type === "actions").elements[0];
		expect(JSON.parse(button.value)).toEqual({ id: 42 }); // not the decoy's 99
	});

	it("matches the visitor email case-insensitively", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyList([{ Id: 42, Email: "Jane.Doe@Gmail.com", ExpectedArrival: ARRIVAL_UTC }]);
		await submitExpectingId(42);
	});

	it("picks the newest Id when duplicate registrations match", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyList([
			{ Id: 41, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC },
			{ Id: 43, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC },
		]);
		await submitExpectingId(43);
	});
});

describe("App Home -> button -> modal", () => {
	it("echoes the url_verification challenge", async () => {
		const body = JSON.stringify({ type: "url_verification", challenge: "chal-123" });
		const res = await run(await slackRequest("/slack/events", body));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("chal-123");
	});

	it("publishes the Home tab with the register button on app_home_opened", async () => {
		let publish: any;
		mockSlack("views.publish", (b) => (publish = b));

		const res = await run(await slackRequest("/slack/events", eventBody({ type: "app_home_opened", user: "U1", tab: "home" })));
		expect(res.status).toBe(200);
		expect(publish.user_id).toBe("U1");
		expect(publish.view.type).toBe("home");
		const actions = publish.view.blocks.find((b: any) => b.type === "actions");
		expect(actions.elements[0].action_id).toBe("open_visitor_form");
	});

	it("ignores app_home_opened for the Messages tab (no outbound calls)", async () => {
		const res = await run(await slackRequest("/slack/events", eventBody({ type: "app_home_opened", user: "U1", tab: "messages" })));
		expect(res.status).toBe(200); // afterEach asserts no views.publish happened
	});

	it("ignores a DM to the bot, since the DM entry point is disabled (no outbound calls)", async () => {
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

describe("delete button -> remove visitor", () => {
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
		// Id and the 🗑️ confirmation is the ✅ message restyled, the only place the
		// Notes and Submitted-by lines survive (the list API omits them). No mockList:
		// asserting no /my call is made on this path.
		const clicked = SUCCESS_TEXT + "\n*Nexudus ID:* 42"; // exactly what the ✅ posts
		mockDelete(42);
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await clickDeleteById(42, clicked);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
		expect(respond.replace_original).toBe(true);
		// Header swapped (matched by text since Slack requalifies the ✅), every
		// visitor field struck, invite note dropped, Submitted-by + ID kept. Line
		// breaks intact because it's sourced from blocks, not the collapsed fallback.
		const deletedText = [
			"🗑️ *Registration deleted*",
			"~*Name:* Jane Doe~",
			"~*Email:* jane.doe@gmail.com~",
			"~*Phone:* +44 7700 900123~",
			`~*Arrival:* ${ARRIVAL_LOCAL} (Europe/London)~`,
			"~*Visiting:* Sam~",
			"~*Notes:* Needs step-free access~",
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

	// A series ✅ message as posted: a summary head section, one row per visit
	// with its own Delete accessory, then the Delete-all actions block (✅
	// requalified as Slack returns it).
	const SERIES_HEAD = [
		"✅️ *Visitor registered*",
		"_The visitor should receive a separate Nexudus invite at the email below for each visit in the series._",
		"*Name:* Jane Doe",
		"*Repeats:* Every week until 2030-10-31 (3 visits)",
	].join("\n");
	const ROW_LINES: Record<number, string> = {
		42: "*Visit 1:* 2030-10-17 10:00 (Europe/London) · Nexudus ID 42",
		43: "*Visit 2:* 2030-10-24 10:00 (Europe/London) · Nexudus ID 43",
		44: "*Visit 3:* 2030-10-31 10:00 (Europe/London) · Nexudus ID 44",
	};
	function seriesBlocks(): unknown[] {
		return [
			{ type: "section", text: { type: "mrkdwn", text: SERIES_HEAD } },
			...[42, 43, 44].map((id) => ({
				type: "section",
				block_id: `visit_${id}`,
				text: { type: "mrkdwn", text: ROW_LINES[id] },
				accessory: { type: "button", action_id: "delete_visitor_row", value: JSON.stringify({ id }) },
			})),
			{ type: "actions", elements: [{ type: "button", action_id: "delete_visitor", value: JSON.stringify({ ids: [42, 43, 44] }) }] },
		];
	}

	// The series' Delete-all button carries every Id captured at registration.
	async function clickDeleteAll(): Promise<Response> {
		return run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor", "trig-del", {
					value: JSON.stringify({ ids: [42, 43, 44] }),
					responseUrl: `${RESPOND_BASE}/respond`,
					messageBlocks: seriesBlocks(),
				}),
			),
		);
	}

	it("deletes every visit in a series and restyles the whole message, rows and Repeats struck", async () => {
		mockDelete(42);
		mockDelete(43);
		mockDelete(44);
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await clickDeleteAll();
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(true);
		// Head restyled, every row struck, all buttons (accessories + actions) gone.
		expect(respond.blocks.map((b: any) => b.type)).toEqual(["section", "section", "section", "section"]);
		expect(respond.blocks[0].text.text).toBe(
			["🗑️ *Registration deleted*", "~*Name:* Jane Doe~", "~*Repeats:* Every week until 2030-10-31 (3 visits)~"].join("\n"),
		);
		expect(respond.blocks[2].text.text).toBe(`~${ROW_LINES[43]}~`);
		expect(JSON.stringify(respond.blocks)).not.toContain("delete_visitor");
		expect(respond.text).not.toContain("separate Nexudus invite"); // note gone
	});

	it("still confirms, with a note, when part of a series is already gone (404)", async () => {
		mockDelete(42);
		mockDelete(43, 404);
		mockDelete(44);
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await clickDeleteAll();
		expect(res.status).toBe(200);
		// The series is fully removed either way, so the message is replaced,
		// with the shortfall noted rather than warned about.
		expect(respond.replace_original).toBe(true);
		expect(respond.blocks[0].text.text).toContain("🗑️ *Registration deleted*");
		expect(respond.blocks.at(-1).text.text).toContain("1 of the 3 visits couldn't be found");
		expect(respond.text).toContain("1 of the 3 visits couldn't be found");
	});

	it("reports the partial outcome (ephemeral) when a series delete hits a hard failure", async () => {
		mockDelete(42);
		mockDelete(43, 500);
		mockDelete(44);
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await clickDeleteAll();
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(false);
		expect(respond.response_type).toBe("ephemeral");
		expect(respond.text).toContain("Deleted 2 of 3 registrations");
		expect(respond.text).toContain("svc@example.com");
	});

	it("deletes one visit from a series and strikes only its row, keeping the other buttons", async () => {
		mockDelete(43);
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor_row", "trig-del", {
					value: JSON.stringify({ id: 43 }),
					blockId: "visit_43",
					responseUrl: `${RESPOND_BASE}/respond`,
					messageBlocks: seriesBlocks(),
				}),
			),
		);
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(true);
		const [head, row42, row43, row44, actions] = respond.blocks;
		expect(head.text.text).toBe(SERIES_HEAD); // summary untouched
		expect(row43.text.text).toBe(`~${ROW_LINES[43]}~`);
		expect(row43.accessory).toBeUndefined(); // its Delete gone
		expect(row42.accessory.action_id).toBe("delete_visitor_row"); // others survive
		expect(row44.accessory.action_id).toBe("delete_visitor_row");
		expect(actions.type).toBe("actions"); // Delete-all survives
	});

	it("warns ephemerally, message untouched, when a row delete 404s", async () => {
		mockDelete(43, 404);
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor_row", "trig-del", {
					value: JSON.stringify({ id: 43 }),
					blockId: "visit_43",
					responseUrl: `${RESPOND_BASE}/respond`,
					messageBlocks: seriesBlocks(),
				}),
			),
		);
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(false);
		expect(respond.response_type).toBe("ephemeral");
		expect(respond.text).toContain("may already be deleted");
	});
});
