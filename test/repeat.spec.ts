// Repeating visits, modeled like the Nexudus portal: every N days/weeks/months,
// ending after N occurrences or on a date, expanded into one multi-visitor
// POST; the inline validation errors and the series result message.

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

	it("expands a weekly repeat ending on a date into one POST of one visitor per date, DST-correct, and DMs the series result", async () => {
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
			repeat: "week",
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

	it("honors the interval: every 2 weeks skips the weeks in between", async () => {
		let visitor: Captured | undefined;
		mockUserInfo();
		mockVisitors((c) => (visitor = c));
		// 2030-07-25 is a Thursday; every 2 weeks until 2030-08-25 is Jul 25,
		// Aug 8 and Aug 22 — the Thursdays in between must not become visits.
		// July/August are BST, so 15:30 UK is 14:30 UTC throughout.
		mockMyList([
			{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-07-25T14:30:00" },
			{ Id: 43, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-08-08T14:30:00" },
			{ Id: 44, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-08-22T14:30:00" },
		]);
		const posts = mockPosts();

		const values = formValues({ ...base, date: "2030-07-25", repeat: "week", every: "2", until: "2030-08-25" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(await res.text()).view.blocks[0].text.text).toContain("Registering 3 visits");

		const body = JSON.parse(visitor!.body!);
		expect(body.map((v: any) => v.ExpectedArrival)).toEqual(["2030-07-25T14:30:00", "2030-08-08T14:30:00", "2030-08-22T14:30:00"]);
		expect(posts[0].text).toContain("*Repeats:* Every 2 weeks until 2030-08-22 (3 visits)");
	});

	it("clamps a monthly repeat's short months from the anchor date", async () => {
		let visitor: Captured | undefined;
		mockUserInfo();
		mockVisitors((c) => (visitor = c));
		// Monthly from Jan 31: Feb clamps to the 28th but March returns to the
		// 31st (stepped from the anchor, not the clamped Feb). BST starts
		// 2031-03-30, so the last visit's 15:30 UK is 14:30 UTC.
		mockMyList([
			{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: "2031-01-31T15:30:00" },
			{ Id: 43, Email: "jane.doe@gmail.com", ExpectedArrival: "2031-02-28T15:30:00" },
			{ Id: 44, Email: "jane.doe@gmail.com", ExpectedArrival: "2031-03-31T14:30:00" },
		]);
		const posts = mockPosts();

		const values = formValues({ ...base, date: "2031-01-31", repeat: "month", until: "2031-03-31" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(await res.text()).view.blocks[0].text.text).toContain("Registering 3 visits");

		const body = JSON.parse(visitor!.body!);
		expect(body.map((v: any) => v.ExpectedArrival)).toEqual(["2031-01-31T15:30:00", "2031-02-28T15:30:00", "2031-03-31T14:30:00"]);
		expect(posts[0].text).toContain("*Repeats:* Every month until 2031-03-31 (3 visits)");
	});

	it("expands a weekly repeat with chosen days across each active week, starting at the first chosen day", async () => {
		let visitor: Captured | undefined;
		mockUserInfo();
		mockVisitors((c) => (visitor = c));
		// Arrival Thursday 2030-07-25 repeating on Mon+Thu until Monday
		// 2030-08-05: the Monday before the arrival is skipped, then Mon and Thu
		// of each following week. All BST, so 15:30 UK is 14:30 UTC.
		mockMyList([
			{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-07-25T14:30:00" },
			{ Id: 43, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-07-29T14:30:00" },
			{ Id: 44, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-08-01T14:30:00" },
			{ Id: 45, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-08-05T14:30:00" },
		]);
		const posts = mockPosts();

		// Selection order must not matter for the expansion or the label.
		const values = formValues({ ...base, date: "2030-07-25", repeat: "week", days: ["thu", "mon"], until: "2030-08-05" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(await res.text()).view.blocks[0].text.text).toContain("Registering 4 visits");

		const body = JSON.parse(visitor!.body!);
		expect(body.map((v: any) => v.ExpectedArrival)).toEqual([
			"2030-07-25T14:30:00",
			"2030-07-29T14:30:00",
			"2030-08-01T14:30:00",
			"2030-08-05T14:30:00",
		]);
		expect(posts[0].text).toContain("*Repeats:* Every week on Mon, Thu until 2030-08-05 (4 visits)");
	});

	it("uses singular wording when the repeat window only fits one visit", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyList([MY_RECORD]);
		const posts = mockPosts();

		// Weekly from Saturday the 20th until Friday the 26th: the next Saturday
		// falls past the end date, so the series is just the first visit.
		const values = formValues({ ...base, repeat: "week", until: "2030-07-26" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(posts[0].text).toContain("*Repeats:* Every week until 2030-07-20 (1 visit)");
		expect(posts[0].text).not.toContain("1 visits");
		// One resolved Id means the single-visit confirmation, not series rows.
		expect(posts[0].text).toContain("*Nexudus ID:* 42");
		expect(posts[0].text).not.toContain("*Visit 1:*");
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

	it("rejects a crafted repeat without an end date (the modal requires 'Ends on')", async () => {
		await expectInlineError(formValues({ ...base, repeat: "week" }), "repeat_until", "Pick the last visit date");
	});

	it("rejects an end date before the first visit", async () => {
		await expectInlineError(formValues({ ...base, repeat: "week", until: "2030-07-19" }), "repeat_until", "before the first visit");
	});

	it("rejects an end date putting the series over 30 visits, naming the cap", async () => {
		// Daily 2030-07-20 → 2030-08-20 inclusive is 32 visits.
		await expectInlineError(formValues({ ...base, repeat: "day", until: "2030-08-20" }), "repeat_until", "more than 30 visits");
	});

	it("rejects a weekly day choice with no visit before the end date", async () => {
		// Arrival Saturday 2030-07-20, Mondays only, ending Sunday the 21st:
		// the first Monday lands past the end date, so the series is empty.
		await expectInlineError(formValues({ ...base, repeat: "week", days: ["mon"], until: "2030-07-21" }), "repeat_until", "No chosen day");
	});

	it("rejects a crafted zero interval (the picker's minimum is 1)", async () => {
		await expectInlineError(formValues({ ...base, repeat: "week", every: "0", until: "2030-08-20" }), "repeat_every", "1 to 99");
	});

	it("drops crafted day values, falling back to the arrival date's weekday", async () => {
		mockUserInfo();
		let visitor: Captured | undefined;
		mockVisitors((c) => (visitor = c));
		mockMyList([MY_RECORD, { Id: 43, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-07-27T14:30:00" }]);
		const posts = mockPosts();

		// "toString" is not a weekday; the filter must not walk the prototype
		// chain, and an all-dropped selection reads as none (plain weekly).
		const values = formValues({ ...base, repeat: "week", days: ["toString"], until: "2030-07-27" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(visitor!.body!).map((v: any) => v.ExpectedArrival)).toEqual(["2030-07-20T14:30:00", "2030-07-27T14:30:00"]);
		expect(posts[0].text).toContain("*Repeats:* Every week until 2030-07-27 (2 visits)"); // no "on …" suffix
	});

	it("reads an inherited-property repeat value as 'none' (single visit, no crash)", async () => {
		// "toString" passes an `in REPEAT_UNITS` check via the prototype chain; it
		// must be treated like any other unrecognized value, not expanded.
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

		const values = formValues({ ...base, repeat: "week", until: "2030-07-27" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("⚠️ *Registration submitted — but not confirmed*");
	});
});
