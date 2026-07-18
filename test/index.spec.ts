import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	fetchMock,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import worker from "../src/index";

const SIGNING_SECRET = "test-signing-secret";
const testEnv = {
	...env,
	NEXUDUS_USERNAME: "svc@example.com",
	NEXUDUS_PASSWORD: "pw",
	SLACK_SIGNING_SECRET: SIGNING_SECRET,
	SLACK_BOT_TOKEN: "xoxb-test",
} satisfies Env;

const NEXUDUS_BASE = `https://${env.NEXUDUS_SUBDOMAIN}.spaces.nexudus.com`;
const SLACK_BASE = "https://slack.com";

// 2026-07-20 14:30:00 UTC → 15:30:00 in Europe/London (BST, UTC+1).
const ARRIVAL_EPOCH = Date.UTC(2026, 6, 20, 14, 30, 0) / 1000;
const ARRIVAL_WALLCLOCK = "2026-07-20T15:30:00";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

// --- Slack signing helpers (mirror the Worker) -----------------------------

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(rawBody: string, timestamp: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(SIGNING_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
	return `v0=${hex(mac)}`;
}

async function slackRequest(
	path: string,
	rawBody: string,
	opts: { timestamp?: number; signature?: string; omitSignature?: boolean } = {},
): Promise<Request<unknown, IncomingRequestCfProperties>> {
	const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		"X-Slack-Request-Timestamp": ts,
	};
	if (!opts.omitSignature) {
		headers["X-Slack-Signature"] = opts.signature ?? (await sign(rawBody, ts));
	}
	return new IncomingRequest(`https://worker.example${path}`, { method: "POST", headers, body: rawBody });
}

async function run(request: Request<unknown, IncomingRequestCfProperties>): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, testEnv, ctx);
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

function submissionBody(
	values?: Record<string, unknown>,
	over: { type?: string; callback_id?: string } = {},
): string {
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
		user: { id: "U1", name: "Vinay Hiremath" },
		view: {
			callback_id: over.callback_id ?? "visitor_registration",
			state: { values: values ?? defaults },
		},
	};
	return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

// --- Mocks -----------------------------------------------------------------

function mockSlack(method: string, capture?: (body: any) => void, reply: object = { ok: true }) {
	fetchMock
		.get(SLACK_BASE)
		.intercept({ path: `/api/${method}`, method: "POST" })
		.reply((opts) => {
			if (capture) capture(JSON.parse(opts.body as string));
			return { statusCode: 200, data: JSON.stringify(reply) };
		});
}

function mockToken(accessToken: string | null = "tok-123") {
	fetchMock
		.get(NEXUDUS_BASE)
		.intercept({ path: "/api/token", method: "POST" })
		.reply(accessToken === null ? 401 : 200, accessToken === null ? "bad" : { access_token: accessToken });
}

function mockVisitors(capture?: (body: any) => void, status = 200, data = "") {
	fetchMock
		.get(NEXUDUS_BASE)
		.intercept({ path: "/api/public/visitors", method: "POST" })
		.reply((opts) => {
			if (capture) capture(JSON.parse(opts.body as string));
			return { statusCode: status, data };
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
		expect(viewsOpen.view.type).toBe("modal");
		// The six expected input blocks are present.
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
	it("acks 200, registers the visitor, and DMs a success message", async () => {
		mockToken();
		let visitor: any;
		let dm: any;
		mockVisitors((b) => (visitor = b), 200, JSON.stringify([{ Id: 1 }]));
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(""); // empty ack closes the modal

		// Outbound Nexudus visitor body.
		expect(Array.isArray(visitor)).toBe(true);
		expect(visitor).toHaveLength(1);
		expect(visitor[0].BusinessId).toBe(1000000000); // from config
		expect(visitor[0].FullName).toBe("Jane Doe");
		expect(visitor[0].Email).toBe("jane.doe@gmail.com");
		expect(visitor[0].PhoneNumber).toBe("+44 7700 900123");
		expect(visitor[0].ExpectedArrival).toBe(ARRIVAL_WALLCLOCK); // wall-clock, no offset
		expect(visitor[0].CustomerNotes).toBe(
			"Submitted via Slack by Vinay Hiremath\nVisiting: Sam\nNeeds step-free access",
		);

		// DM back to the submitter.
		expect(dm.channel).toBe("U1");
		expect(dm.text).toBe("✅ Registered Jane Doe, expected 2026-07-20 15:30:00 (Europe/London).");
	});

	it("DMs an auth failure when the Nexudus token call fails (no visitor call)", async () => {
		mockToken(null);
		let dm: any;
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("could not sign in to Nexudus");
	});

	it("DMs the Nexudus rejection detail on a 400", async () => {
		mockToken();
		mockVisitors(undefined, 400, "Invalid Email Address");
		let dm: any;
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("❌ Nexudus rejected the registration:");
		expect(dm.text).toContain("Invalid Email Address");
	});

	it("DMs a required-fields error and never calls Nexudus when arrival is missing", async () => {
		let dm: any;
		mockSlack("chat.postMessage", (b) => (dm = b));

		// Omit the datetimepicker value entirely.
		const values = {
			full_name: { value: { type: "plain_text_input", value: "Jane Doe" } },
			email: { value: { type: "email_text_input", value: "jane.doe@gmail.com" } },
			arrival: { value: { type: "datetimepicker", selected_date_time: null } },
		};
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("required");
	});

	it("acks and ignores a submission with a foreign callback_id (no outbound calls)", async () => {
		const res = await run(
			await slackRequest("/slack/interactivity", submissionBody(undefined, { callback_id: "something_else" })),
		);
		expect(res.status).toBe(200);
		// No interceptors registered → assertNoPendingInterceptors confirms nothing was called.
	});
});
