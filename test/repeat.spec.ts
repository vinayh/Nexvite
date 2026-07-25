// Repeating visits: picking "Repeat until" turns the visit into a weekly
// series — every N weeks on chosen days, up to that inclusive end date —
// expanded into one multi-visitor POST; the inline validation errors and the
// series result message.

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

		const values = formValues({ ...base, date: "2030-07-25", every: "2", days: ["thu"], until: "2030-08-25" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(await res.text()).view.blocks[0].text.text).toContain("Registering 3 visits");

		const body = JSON.parse(visitor!.body!);
		expect(body.map((v: any) => v.ExpectedArrival)).toEqual(["2030-07-25T14:30:00", "2030-08-08T14:30:00", "2030-08-22T14:30:00"]);
		expect(posts[0].text).toContain("*Repeats:* Every 2 weeks on Thu until 2030-08-22 (3 visits)");
	});

	it("expands chosen days across each active week, starting at the first chosen day", async () => {
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
		const values = formValues({ ...base, date: "2030-07-25", days: ["thu", "mon"], until: "2030-08-05" });
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

	it("confirms a series whose visits are split across /my pages", async () => {
		mockUserInfo();
		mockVisitors();
		// The bug this covers: /my pages at 15 records, so a series longer than
		// what's left on page 1 used to come back partially matched, and a
		// partial match is reported as unconfirmed even though the POST landed.
		mockMyList([{ Id: 42, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-10-17T09:00:00" }], { hasNext: true });
		mockMyList(
			[
				{ Id: 43, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-10-24T09:00:00" },
				{ Id: 44, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-10-31T10:00:00" },
			],
			{ page: 2 },
		);
		const posts = mockPosts();

		const values = formValues({
			fullName: "Jane Doe",
			email: "jane.doe@gmail.com",
			date: "2030-10-17",
			time: "10:00",
			until: "2030-11-01",
		});
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);

		// Every visit resolved, so this is the success path with all three Ids.
		expect(posts).toHaveLength(2); // DM + channel log
		expect(posts[0].text).not.toContain("not confirmed");
		expect(posts[0].text).toContain("*Visit 1:* 2030-10-17 10:00 (Europe/London) · Nexudus ID 42");
		expect(posts[0].text).toContain("*Visit 3:* 2030-10-31 10:00 (Europe/London) · Nexudus ID 44");
	});

	it("uses singular wording when the repeat window only fits one visit", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyList([MY_RECORD]);
		const posts = mockPosts();

		// Weekly from Saturday the 20th until Friday the 26th: the next Saturday
		// falls past the end date, so the series is just the first visit.
		const values = formValues({ ...base, days: ["sat"], until: "2030-07-26" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(posts[0].text).toContain("*Repeats:* Every week on Sat until 2030-07-20 (1 visit)");
		expect(posts[0].text).not.toContain("1 visits");
		// One resolved Id means the single-visit confirmation, not series rows.
		expect(posts[0].text).toContain("*Nexudus ID:* 42");
		expect(posts[0].text).not.toContain("*Visit 1:*");
	});

	it("ignores crafted interval and day values when no end date is picked (single visit)", async () => {
		// Blank "Repeat until" is the no-repeat default, so the other repeat
		// fields must not turn a single visit into a series.
		mockUserInfo();
		let visitor: Captured | undefined;
		mockVisitors((c) => (visitor = c));
		mockMyList([MY_RECORD]);
		mockPosts();

		const values = formValues({ ...base, every: "2", days: ["mon", "tue"] });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(await res.text()).view.blocks[0].text.text).toContain("Registering your visitor");
		expect(JSON.parse(visitor!.body!)).toHaveLength(1);
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

	it("rejects an end date before the first visit", async () => {
		await expectInlineError(formValues({ ...base, until: "2030-07-19" }), "repeat_until", "before the first visit");
	});

	it("rejects an end date putting the series over 30 visits, naming the cap", async () => {
		// Every day (all seven selected) 2030-07-20 → 2030-08-20 inclusive is 32
		// visits.
		const everyDay = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
		await expectInlineError(formValues({ ...base, days: everyDay, until: "2030-08-20" }), "repeat_until", "more than 30 visits");
	});

	it("rejects a day choice with no visit before the end date", async () => {
		// Arrival Saturday 2030-07-20, Mondays only, ending Sunday the 21st:
		// the first Monday lands past the end date, so the series is empty.
		await expectInlineError(formValues({ ...base, days: ["mon"], until: "2030-07-21" }), "repeat_until", "No chosen day");
	});

	it("rejects a crafted zero interval (the picker's minimum is 1)", async () => {
		await expectInlineError(formValues({ ...base, every: "0", until: "2030-08-20" }), "repeat_every", "1 to 99");
	});

	it("rejects an interval above the cap (the picker's maximum is MAX_INTERVAL)", async () => {
		await expectInlineError(formValues({ ...base, every: "100", until: "2030-08-20" }), "repeat_every", "1 to 99");
	});

	it("drops crafted day values, falling back to the arrival date's weekday", async () => {
		mockUserInfo();
		let visitor: Captured | undefined;
		mockVisitors((c) => (visitor = c));
		mockMyList([MY_RECORD, { Id: 43, Email: "jane.doe@gmail.com", ExpectedArrival: "2030-07-27T14:30:00" }]);
		const posts = mockPosts();

		// "toString" is not a weekday; the filter must not walk the prototype
		// chain, and an all-dropped selection reads as none (arrival weekday).
		const values = formValues({ ...base, days: ["toString"], until: "2030-07-27" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(JSON.parse(visitor!.body!).map((v: any) => v.ExpectedArrival)).toEqual(["2030-07-20T14:30:00", "2030-07-27T14:30:00"]);
		expect(posts[0].text).toContain("*Repeats:* Every week until 2030-07-27 (2 visits)"); // no "on …" suffix
	});

	it("goes unconfirmed when the Id lookup can't resolve every visit in the series", async () => {
		mockUserInfo();
		mockVisitors();
		mockMyList([MY_RECORD]); // first visit only, second unmatched — first lookup
		mockMyList([MY_RECORD]); // retry
		let dm: any;
		mockSlack("chat.postMessage", (b) => (dm = b));

		const values = formValues({ ...base, until: "2030-07-27" });
		const res = await run(await slackRequest("/slack/interactivity", submissionBody(values)));
		expect(res.status).toBe(200);
		expect(dm.text).toContain("⚠️ *Registration submitted — but not confirmed*");
	});
});
