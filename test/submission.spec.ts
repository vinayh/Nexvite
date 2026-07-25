// The single-visit submission flow: view_submission → Nexudus create → Id
// lookup → modal update + DM + channel log, including the auth-refresh chain
// and the /my response-shape parsing the Id lookup tolerates.

import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { TOKEN_KEY, lookupPaging } from "../src/nexudus";
import {
	ARRIVAL_DATE,
	ARRIVAL_TIME,
	ARRIVAL_UTC,
	AUTH,
	MY_RECORD,
	NEXUDUS_BASE,
	SLACK_BASE,
	SUCCESS_TEXT,
	formValues,
	mockMyList,
	mockMyListRaw,
	mockPosts,
	mockRefresh,
	mockSlack,
	mockUserInfo,
	mockVisitors,
	run,
	seed,
	setupSuite,
	slackRequest,
	submissionBody,
	type Captured,
} from "./helpers";

setupSuite();

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
		expect(dm.text).toContain("*Visitor name:* Jane Doe"); // still echoes what was submitted
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
		expect(dm.text).toContain("*Visitor name:* Jane Doe"); // summary included on failure too
		// The operational hint stays out of the member-facing message.
		expect(dm.text).not.toContain("re-seed");
		expect(dm.text).not.toContain("token");
		expect(dm.text).not.toContain("admin");
		// KV untouched because the refresh failed.
		expect(JSON.parse((await env.TOKENS.get(TOKEN_KEY))!)).toEqual(AUTH);
	});

	// The auth record the "other Worker" leaves in KV after winning a refresh
	// race (the refresh token is single-use and the namespace is shared).
	const RACED = { username: "svc@example.com", access_token: "other-access", refresh_token: "other-refresh" };

	// This Worker's refresh loses the race: the exchange 400s (the single-use
	// token was already spent) and the winner's rotation lands in KV meanwhile.
	// The reply is delayed a tick so the unawaited put settles before the
	// Worker re-reads the record.
	function mockRefreshLosesRace() {
		fetchMock
			.get(NEXUDUS_BASE)
			.intercept({ path: "/api/token", method: "POST" })
			.reply(() => {
				void env.TOKENS.put(TOKEN_KEY, JSON.stringify(RACED));
				return { statusCode: 400, data: "bad_grant" };
			})
			.delay(10);
	}

	it("recovers from a lost refresh race: re-reads the rotated KV record and retries with its token", async () => {
		let retried: Captured | undefined;
		mockUserInfo();
		mockVisitors(undefined, 401); // first attempt: token already superseded
		mockRefreshLosesRace();
		mockVisitors((c) => (retried = c), 200); // the single retry, with the winner's token
		mockMyList([MY_RECORD]);
		const posts = mockPosts();

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(retried?.auth).toBe("Bearer other-access");
		// The winner's record survives; the loser must not write anything over it.
		expect(JSON.parse((await env.TOKENS.get(TOKEN_KEY))!)).toEqual(RACED);
		expect(posts[0].text).toBe(`${SUCCESS_TEXT}\n*Nexudus ID:* 42`);
	});

	it("DMs the friendly failure when the race-recovery retry still 401s (no further retries)", async () => {
		let dm: any;
		mockUserInfo();
		mockVisitors(undefined, 401);
		mockRefreshLosesRace();
		mockVisitors(undefined, 401); // the rotated token is rejected too: broken chain
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.channel).toBe("U1");
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("couldn't connect to the visitor system");
		expect(dm.text).not.toContain("token"); // ops hints stay out of the DM
		// afterEach's assertNoPendingInterceptors proves exactly one retry ran.
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

		const values = formValues({ fullName: "N".repeat(250), email: "jane.doe@gmail.com", date: ARRIVAL_DATE, time: ARRIVAL_TIME });
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
		const values = formValues({ fullName: "Jane Doe", email: "jane.doe@gmail.com", date: ARRIVAL_DATE, time: null });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("required");
	});

	it("rejects a past arrival with an inline field error (no outbound calls)", async () => {
		const values = formValues({ fullName: "Jane Doe", email: "jane.doe@gmail.com", date: "2020-01-01", time: "12:00" });
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

		const values = formValues({ fullName: "Jane <!channel> & Co", email: "jane.doe@gmail.com", date: ARRIVAL_DATE, time: ARRIVAL_TIME });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);

		// The Slack messages carry the escaped form, no mention injection…
		for (const post of posts) {
			expect(post.text).toContain("*Visitor name:* Jane &lt;!channel&gt; &amp; Co");
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

	it("acks with a plain 200 and does nothing when the submission carries no user id", async () => {
		// No mocks registered: with nobody to DM, nothing may go out at all.
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(undefined, { user: {} })));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(""); // no response_action; the modal just closes
	});

	it("treats a submission with no state as missing its required fields", async () => {
		let dm: any;
		mockUserInfo();
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody(undefined, { noState: true })));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(dm.text).toContain("required");
	});

	it("falls back to user.username when the payload carries no name", async () => {
		// The ok:false reply also carries no error code → logged as "unknown".
		mockUserInfo({ ok: false });
		mockVisitors();
		mockMyList([MY_RECORD]);
		const posts = mockPosts();

		const res = await run(
			await slackRequest("/slack/interactivity", submissionBody(undefined, { user: { id: "U1", username: "vinay.h" } })),
		);
		expect(res.status).toBe(200);
		expect(posts[0].text).toContain("*Submitted by:* vinay.h");
	});

	it("labels the submitter 'a Slack user' when the payload carries no usable name", async () => {
		mockUserInfo({ ok: false, error: "missing_scope" });
		mockVisitors();
		mockMyList([MY_RECORD]);
		const posts = mockPosts();

		const res = await run(await slackRequest("/slack/interactivity", submissionBody(undefined, { user: { id: "U1" } })));
		expect(res.status).toBe(200);
		expect(posts[0].text).toContain("*Submitted by:* a Slack user");
	});

	it("uses the top-level real_name when users.info returns no profile", async () => {
		mockUserInfo({ ok: true, user: { real_name: "Jane Admin" } });
		mockVisitors();
		mockMyList([MY_RECORD]);
		const posts = mockPosts();

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(posts[0].text).toContain("*Submitted by:* Jane Admin");
	});

	it("falls back to the username when users.info returns no name at all", async () => {
		mockUserInfo({ ok: true, user: {} });
		mockVisitors();
		mockMyList([MY_RECORD]);
		const posts = mockPosts();

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(posts[0].text).toContain("*Submitted by:* vinay");
	});

	it("names the HTTP status when Nexudus rejects with an empty body", async () => {
		let dm: any;
		mockUserInfo();
		mockVisitors(undefined, 400, ""); // rejection with nothing to quote
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("Nexudus rejected the registration: HTTP 400");
	});

	it("treats whitespace-only optional fields as absent (summary and Nexudus notes)", async () => {
		let visitor: Captured | undefined;
		mockUserInfo();
		mockVisitors((c) => (visitor = c));
		mockMyList([MY_RECORD]);
		const posts = mockPosts();

		const values = formValues({
			fullName: "Jane Doe",
			email: "jane.doe@gmail.com",
			date: ARRIVAL_DATE,
			time: ARRIVAL_TIME,
			host: "   ",
			notes: " \t ",
		});
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(visitor!.body!)[0].CustomerNotes).toBe("Submitted via Slack by Vinay Hiremath");
		expect(posts[0].text).not.toContain("*Visiting:*");
		expect(posts[0].text).not.toContain("*Notes:*");
	});

	it("treats a refresh 200 with a non-JSON body as a failure and leaves KV untouched", async () => {
		let dm: any;
		mockUserInfo();
		mockVisitors(undefined, 401);
		// e.g. an HTML error page from a proxy that still says 200.
		fetchMock.get(NEXUDUS_BASE).intercept({ path: "/api/token", method: "POST" }).reply(200, "<html>proxy error</html>");
		mockSlack("chat.postMessage", (b) => (dm = b));

		const res = await run(await slackRequest("/slack/interactivity", submissionBody()));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("❌ *Registration failed*");
		expect(JSON.parse((await env.TOKENS.get(TOKEN_KEY))!)).toEqual(AUTH);
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
		// The auth record predates the {username, ...} shape in this form.
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
		const values = formValues({ fullName: "Jane Doe", email: "jane.doe@gmail.com", date: "2031-01-20", time: "14:30" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(visitor!.body!)[0].ExpectedArrival).toBe("2031-01-20T14:30:00");
		expect(posts[0].text).toContain("*Arrival:* 2031-01-20 14:30 (Europe/London)");
	});

	it("resolves an arrival in the spring-forward gap to the next real instant", async () => {
		let visitor: Captured | undefined;
		mockUserInfo();
		mockVisitors((c) => (visitor = c));
		// UK clocks jump 01:00 GMT → 02:00 BST on 2031-03-30, so 01:30 local never
		// happens. It must still resolve to a real instant rather than NaN: the
		// gap shifts it forward an hour to 02:30 BST, which is 01:30 UTC.
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: "2031-03-30T01:30:00" }]);
		const posts = mockPosts();

		const values = formValues({ fullName: "Jane Doe", email: "jane.doe@gmail.com", date: "2031-03-30", time: "01:30" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(visitor!.body!)[0].ExpectedArrival).toBe("2031-03-30T01:30:00");
		// The member is shown the instant that actually exists, not what they typed.
		expect(posts[0].text).toContain("*Arrival:* 2031-03-30 02:30 (Europe/London)");
	});

	it("drops the dangling half when the length cap splits an emoji", async () => {
		let visitor: Captured | undefined;
		mockUserInfo();
		mockVisitors((c) => (visitor = c));
		mockMyList([MY_RECORD]);
		mockPosts();

		// 199 chars + an emoji (two code units): the 200-char cap lands mid-pair.
		const values = formValues({ fullName: "N".repeat(199) + "😀", email: "jane.doe@gmail.com", date: ARRIVAL_DATE, time: ARRIVAL_TIME });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(visitor!.body!)[0].FullName).toBe("N".repeat(199)); // no lone surrogate
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

	it("treats a non-JSON /my body as unconfirmed", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyListRaw("<html>bad gateway</html>"); // first lookup
		mockMyListRaw("<html>bad gateway</html>"); // retry
		await submitExpectingUnconfirmed();
	});

	it("follows HasNextPage when the record isn't on the first page", async () => {
		mockUserInfo();
		mockVisitors();
		// /my pages at 15 records by default, so a busy account pushes a new
		// registration off page 1 — the lookup must walk on rather than give up.
		mockMyList([], { hasNext: true });
		mockMyList([MY_RECORD], { page: 2 });
		await submitExpectingId(42);
	});

	it("stops paging as soon as every visit is matched", async () => {
		mockUserInfo();
		mockVisitors();
		// Page 1 resolves the visit, so page 2 is never requested (an unused
		// interceptor would fail assertNoPendingInterceptors).
		mockMyList([MY_RECORD], { hasNext: true });
		await submitExpectingId(42);
	});

	it("gives up after maxPages and reports unconfirmed", async () => {
		mockUserInfo();
		mockVisitors();
		const pages = lookupPaging.maxPages;
		lookupPaging.maxPages = 2;
		try {
			// Every page claims another follows and none holds the record: both
			// attempts walk the cap, then the soft-unconfirmed path.
			for (let attempt = 0; attempt < 2; attempt++) {
				mockMyList([], { hasNext: true });
				mockMyList([], { page: 2, hasNext: true });
			}
			await submitExpectingUnconfirmed();
		} finally {
			lookupPaging.maxPages = pages;
		}
	});

	it("skips records whose arrival doesn't parse and still resolves the rest", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyList([{ Id: 41, Email: "jane.doe@gmail.com", ExpectedArrival: "not-a-date" }, MY_RECORD]);
		await submitExpectingId(42);
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

	it("picks the newest Id when duplicates arrive newest-first too", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyList([
			{ Id: 43, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC },
			{ Id: 41, Email: "jane.doe@gmail.com", ExpectedArrival: ARRIVAL_UTC },
		]);
		await submitExpectingId(43);
	});
});
