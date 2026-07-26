// The ✅ confirmation's Delete buttons: single visits and per-visit series
// rows, with the 🗑️ restyling of the clicked message and private warnings on
// failure. Older Delete-all buttons are rejected without an outbound delete.

import { describe, it, expect } from "vitest";
import {
	ARRIVAL_LOCAL,
	NEXUDUS_BASE,
	SUCCESS_TEXT,
	blockActionsBody,
	fetchMock,
	run,
	setupSuite,
	slackRequest,
} from "./helpers";

setupSuite();

describe("delete button -> remove visitor", () => {
	const RESPOND_BASE = "https://hooks.slack.test";

	function mockDelete(id: number, status = 200) {
		fetchMock
			.get(NEXUDUS_BASE)
			.intercept({ path: `/api/public/visitors/${id}`, method: "DELETE" })
			.reply(status, "");
	}

	// One interceptor per expected response_url post, capturing each in order.
	function mockRespond(capture: (body: any) => void, times = 1) {
		for (let i = 0; i < times; i++) {
			fetchMock
				.get(RESPOND_BASE)
				.intercept({ path: "/respond", method: "POST" })
				.reply((opts) => {
					capture(JSON.parse(opts.body as string));
					return { statusCode: 200, data: "ok" };
				});
		}
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
			"~*Visitor name:* Jane Doe~",
			"~*Visitor email:* jane.doe@gmail.com~",
			"~*Visitor phone:* +44 7700 900123~",
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

	it("restyles from the fallback text when the clicked message carries no blocks", async () => {
		mockDelete(42);
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor", "trig-del", {
					value: JSON.stringify({ id: 42 }),
					responseUrl: `${RESPOND_BASE}/respond`,
					messageRaw: { text: "✅️ *Visitor registered*\n*Visitor name:* Jane Doe\n*Nexudus ID:* 42" },
				}),
			),
		);
		expect(res.status).toBe(200);
		const expected = ["🗑️ *Registration deleted*", "~*Visitor name:* Jane Doe~", "*Nexudus ID:* 42"].join("\n");
		expect(respond.replace_original).toBe(true);
		expect(respond.text).toBe(expected);
		expect(respond.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: expected } }]);
	});

	it("survives a response_url post that returns an error status (delete still done)", async () => {
		mockDelete(42);
		fetchMock.get(RESPOND_BASE).intercept({ path: "/respond", method: "POST" }).reply(500, "");

		const res = await clickDeleteById(42, "✅ *Visitor registered*\n*Nexudus ID:* 42");
		expect(res.status).toBe(200); // the failure is only log-worthy
	});

	// A series ✅ message as posted: a summary head section followed by one row
	// per visit with its own Delete accessory (✅ requalified by Slack).
	const SERIES_HEAD = [
		"✅️ *Visitor registered*",
		"_The visitor should receive a separate Nexudus invite at the email below for each visit in the series._",
		"*Visitor name:* Jane Doe",
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
		];
	}

	it("rejects Delete-all clicks from older messages without calling Nexudus", async () => {
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor", "trig-del", {
					value: JSON.stringify({ ids: [42, 43, 44] }),
					responseUrl: `${RESPOND_BASE}/respond`,
					messageBlocks: seriesBlocks(),
				}),
			),
		);
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(false);
		expect(respond.response_type).toBe("ephemeral");
		expect(respond.text).toContain("Delete each visit separately");
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
		const [head, row42, row43, row44] = respond.blocks;
		expect(head.text.text).toBe(SERIES_HEAD); // summary untouched
		expect(row43.text.text).toBe(`~${ROW_LINES[43]}~`);
		expect(row43.accessory).toBeUndefined(); // its Delete gone
		expect(row42.accessory.action_id).toBe("delete_visitor_row"); // others survive
		expect(row44.accessory.action_id).toBe("delete_visitor_row");
	});

	it("confirms ephemerally when the deleted row can't be found in the message (stale block_id)", async () => {
		mockDelete(43);
		let respond: any;
		mockRespond((b) => (respond = b));

		// The visit is still deleted in Nexudus, so the clicker gets a truthful
		// ephemeral instead of a rebuilt message.
		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor_row", "trig-del", {
					value: JSON.stringify({ id: 43 }),
					blockId: "visit_99",
					responseUrl: `${RESPOND_BASE}/respond`,
					messageBlocks: seriesBlocks(),
				}),
			),
		);
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(false);
		expect(respond.response_type).toBe("ephemeral");
		expect(respond.text).toBe("🗑️ Visit deleted from Nexudus.");
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
