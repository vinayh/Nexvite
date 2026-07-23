// Repeating visits: cadence + repeat-until expansion into one multi-visitor
// POST, the inline validation errors, and the series result message.

import { describe, it, expect, beforeEach } from "vitest";
import {
	ARRIVAL_DATE,
	ARRIVAL_TIME,
	MY_RECORD,
	formValues,
	mockMyList,
	mockPosts,
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

		// Until is a Friday: the last matching Thursday is Oct 31, and the summary
		// must show that real last visit, not the raw picker value.
		const values = formValues({
			fullName: "Jane Doe",
			email: "jane.doe@gmail.com",
			date: "2030-10-17",
			time: "10:00",
			repeat: "weekly",
			until: "2030-11-01",
		});
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

	const base = { fullName: "Jane Doe", email: "jane.doe@gmail.com", date: ARRIVAL_DATE, time: ARRIVAL_TIME };

	it("rejects a repeat without an end date", async () => {
		await expectInlineError(formValues({ ...base, repeat: "weekly" }), "repeat_until", "Pick the last visit date");
	});

	it("rejects an end date before the first visit", async () => {
		await expectInlineError(formValues({ ...base, repeat: "weekly", until: "2030-07-19" }), "repeat_until", "before the first visit");
	});

	it("rejects a series longer than 30 visits, naming the cap", async () => {
		// Daily 2030-07-20 → 2030-08-20 inclusive is 32 visits.
		await expectInlineError(formValues({ ...base, repeat: "daily", until: "2030-08-20" }), "repeat_until", "more than 30 visits");
	});

	it("rejects a weekday repeat starting on a weekend", async () => {
		// ARRIVAL_DATE 2030-07-20 is a Saturday.
		await expectInlineError(formValues({ ...base, repeat: "weekdays", until: "2030-07-25" }), "repeat", "weekend");
	});

	it("reads an inherited-property repeat value as 'none' (single visit, no crash)", async () => {
		// "toString" passes an `in REPEATS` check via the prototype chain; it must
		// be treated like any other unrecognized value, not expanded as a cadence.
		mockUserInfo();
		let visitor: Captured | undefined;
		mockVisitors((c) => (visitor = c));
		mockMyList([MY_RECORD]);
		mockPosts();

		const values = formValues({ ...base, repeat: "toString", until: "2030-08-20" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(await res.text()).view.blocks[0].text.text).toContain("Registering your visitor");
		expect(JSON.parse(visitor!.body!)).toHaveLength(1); // one visit, until ignored
	});

	it("goes unconfirmed when the Id lookup can't resolve every visit in the series", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyList([MY_RECORD]); // first visit only, second unmatched — first lookup
		mockMyList([MY_RECORD]); // retry
		let dm: any;
		mockSlack("chat.postMessage", (b) => (dm = b));

		const values = formValues({ ...base, repeat: "weekly", until: "2030-07-27" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("⚠️ *Registration submitted — but not confirmed*");
	});
});
