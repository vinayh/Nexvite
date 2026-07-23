// The ✅ confirmation's Delete buttons: single visit, whole series
// (Delete-all), and per-visit row deletes, with the 🗑️ restyling of the
// clicked message and the ephemeral warnings on failure.

import { fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
	ARRIVAL_LOCAL,
	NEXUDUS_BASE,
	SUCCESS_TEXT,
	blockActionsBody,
	run,
	seed,
	setupSuite,
	slackRequest,
} from "./helpers";

setupSuite();

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
