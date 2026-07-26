// Endpoint plumbing: routing, per-IP rate limiting, and Slack request
// signature verification — everything that runs before a payload is handled.

import { describe, it, expect } from "vitest";
import { COMMAND_BODY, IncomingRequest, mockSlack, run, setupSuite, slackRequest, testEnv } from "./helpers";

setupSuite();

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
