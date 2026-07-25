// The ✅ confirmation's Delete buttons: single visit, whole series
// (Delete-all), and per-visit row deletes, with the 🗑️ restyling of the
// clicked message and the ephemeral warnings on failure.

import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { TOKEN_KEY } from "../src/nexudus";
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

	// One interceptor per expected post, capturing each in order. A Delete-all
	// posts more than once: the ⏳ placeholder first, then the result (and, when
	// the delete fails, the original message restored before the warning), so
	// `times` is the exact count and a capture that overwrites ends on the last.
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

	it("ignores a Delete-all whose ids are not all numbers (no outbound calls)", async () => {
		// Well-formed JSON but a crafted element type; the whole ref is dropped.
		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor", "trig-del", {
					value: JSON.stringify({ ids: [42, "43"] }),
					responseUrl: `${RESPOND_BASE}/respond`,
				}),
			),
		);
		expect(res.status).toBe(200);
	});

	it("ignores a row-delete click whose value carries no id (no outbound calls)", async () => {
		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor_row", "trig-del", {
					value: "{}",
					blockId: "visit_43",
					responseUrl: `${RESPOND_BASE}/respond`,
				}),
			),
		);
		expect(res.status).toBe(200);
	});

	it("reports a friendly failure when the auth chain is broken mid-delete (unseeded KV)", async () => {
		await env.TOKENS.delete(TOKEN_KEY); // undo the describe-level seed
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await clickDeleteById(42, "✅ *Visitor registered*\n*Nexudus ID:* 42");
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(false);
		expect(respond.response_type).toBe("ephemeral");
		expect(respond.text).toContain("Deleting failed");
		expect(respond.text).toContain("the space team"); // no KV record to name a contact
	});

	it("restyles from the fallback text when the clicked message carries no blocks, striking legacy labels", async () => {
		// "*Name:*" is the label older ✅ messages were posted with; their Delete
		// buttons still work, so the restyle must keep striking it.
		mockDelete(42);
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor", "trig-del", {
					value: JSON.stringify({ id: 42 }),
					responseUrl: `${RESPOND_BASE}/respond`,
					messageRaw: { text: "✅️ *Visitor registered*\n*Name:* Jane Doe\n*Nexudus ID:* 42" },
				}),
			),
		);
		expect(res.status).toBe(200);
		const expected = ["🗑️ *Registration deleted*", "~*Name:* Jane Doe~", "*Nexudus ID:* 42"].join("\n");
		expect(respond.replace_original).toBe(true);
		expect(respond.text).toBe(expected);
		expect(respond.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: expected } }]);
	});

	it("falls back to the bare 🗑️ header when the click carries no message at all", async () => {
		mockDelete(42);
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor", "trig-del", {
					value: JSON.stringify({ id: 42 }),
					responseUrl: `${RESPOND_BASE}/respond`,
				}),
			),
		);
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(true);
		expect(respond.text).toBe("🗑️ *Registration deleted*");
	});

	it("survives a response_url post that returns an error status (delete still done)", async () => {
		mockDelete(42);
		fetchMock.get(RESPOND_BASE).intercept({ path: "/respond", method: "POST" }).reply(500, "");

		const res = await clickDeleteById(42, "✅ *Visitor registered*\n*Nexudus ID:* 42");
		expect(res.status).toBe(200); // the failure is only log-worthy
	});

	it("survives a response_url post whose fetch itself throws", async () => {
		mockDelete(42);
		fetchMock.get(RESPOND_BASE).intercept({ path: "/respond", method: "POST" }).replyWithError(new Error("connection reset"));

		const res = await clickDeleteById(42, "✅ *Visitor registered*\n*Nexudus ID:* 42");
		expect(res.status).toBe(200);
	});

	// A series ✅ message as posted: a summary head section, one row per visit
	// with its own Delete accessory, then the Delete-all actions block (✅
	// requalified as Slack returns it).
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

	it("shows the ⏳ working state, buttons dropped, before a series delete finishes", async () => {
		// A series is deleted one visit at a time and paced, so the click would
		// otherwise sit silent; the placeholder lands first and takes every button
		// with it, so the same Ids can't be submitted twice.
		mockDelete(42);
		mockDelete(43);
		mockDelete(44);
		const posts: any[] = [];
		mockRespond((b) => posts.push(b), 2);

		const res = await clickDeleteAll();
		expect(res.status).toBe(200);
		expect(posts).toHaveLength(2);

		const [working, final] = posts;
		expect(working.replace_original).toBe(true);
		// Plain member copy: what's happening and how long, with no hint of why
		// it's paced.
		expect(working.blocks.at(-1).text.text).toBe("⏳ *Deleting 3 visits…* This can take up to a minute.");
		expect(working.text).toContain("⏳ *Deleting 3 visits…*");
		// The summary survives so the member still sees what's going; every
		// button is gone until the result lands.
		expect(working.blocks[0].text.text).toBe(SERIES_HEAD);
		expect(JSON.stringify(working.blocks)).not.toContain("delete_visitor");

		// The result still rebuilds from the original message, not the placeholder.
		expect(final.blocks[0].text.text).toContain("🗑️ *Registration deleted*");
		expect(final.blocks[2].text.text).toBe(`~${ROW_LINES[43]}~`);
		expect(JSON.stringify(final.blocks)).not.toContain("Deleting 3 visits");
	});

	it("posts no working state for a single-visit delete (it's already quick)", async () => {
		mockDelete(42);
		const posts: any[] = [];
		mockRespond((b) => posts.push(b), 1);

		const res = await clickDeleteById(42, "✅ *Visitor registered*\n*Nexudus ID:* 42");
		expect(res.status).toBe(200);
		expect(posts).toHaveLength(1);
		expect(posts[0].text).not.toContain("⏳");
	});

	it("puts the message back, buttons and all, when a series delete fails after the working state", async () => {
		// Without the restore the placeholder's button-less message would strand
		// the visits that are still registered.
		mockDelete(42);
		mockDelete(43, 500);
		mockDelete(44);
		const posts: any[] = [];
		mockRespond((b) => posts.push(b), 3);

		const res = await clickDeleteAll();
		expect(res.status).toBe(200);
		expect(posts).toHaveLength(3);

		const [working, restored, warning] = posts;
		expect(working.text).toContain("⏳ *Deleting 3 visits…*");
		expect(restored.replace_original).toBe(true);
		expect(restored.blocks).toEqual(seriesBlocks()); // exactly as clicked, buttons live again
		expect(warning.response_type).toBe("ephemeral");
		expect(warning.text).toContain("Deleted 2 of 3 registrations");
	});

	it("deletes every visit in a series and restyles the whole message, rows and Repeats struck", async () => {
		mockDelete(42);
		mockDelete(43);
		mockDelete(44);
		let respond: any;
		mockRespond((b) => (respond = b), 2);

		const res = await clickDeleteAll();
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(true);
		// Head restyled, every row struck, all buttons (accessories + actions) gone.
		expect(respond.blocks.map((b: any) => b.type)).toEqual(["section", "section", "section", "section"]);
		expect(respond.blocks[0].text.text).toBe(
			["🗑️ *Registration deleted*", "~*Visitor name:* Jane Doe~", "~*Repeats:* Every week until 2030-10-31 (3 visits)~"].join("\n"),
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
		mockRespond((b) => (respond = b), 2); // ⏳ placeholder, then the result

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
		mockRespond((b) => (respond = b), 3);

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

	it("warns with the plural wording when every visit in a series is already gone", async () => {
		mockDelete(42, 404);
		mockDelete(43, 404);
		mockDelete(44, 404);
		let respond: any;
		mockRespond((b) => (respond = b), 3);

		const res = await clickDeleteAll();
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(false);
		expect(respond.response_type).toBe("ephemeral");
		expect(respond.text).toContain("Couldn't find these registrations");
		expect(respond.text).toContain("svc@example.com");
	});

	it("passes an already-struck row through Delete-all without double-striking it", async () => {
		// Row 43 was deleted via its own button earlier: struck text, accessory
		// gone, already absent from Nexudus — but Delete-all still carries every
		// Id captured at registration.
		const blocks = seriesBlocks() as any[];
		blocks[2] = { type: "section", block_id: "visit_43", text: { type: "mrkdwn", text: `~${ROW_LINES[43]}~` } };
		mockDelete(42);
		mockDelete(43, 404); // already gone
		mockDelete(44);
		let respond: any;
		mockRespond((b) => (respond = b), 2);

		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor", "trig-del", {
					value: JSON.stringify({ ids: [42, 43, 44] }),
					responseUrl: `${RESPOND_BASE}/respond`,
					messageBlocks: blocks,
				}),
			),
		);
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(true);
		expect(respond.blocks[1].text.text).toBe(`~${ROW_LINES[42]}~`);
		expect(respond.blocks[2].text.text).toBe(`~${ROW_LINES[43]}~`); // single strike, not ~~…~~
		expect(respond.blocks[3].text.text).toBe(`~${ROW_LINES[44]}~`);
		expect(respond.blocks.at(-1).text.text).toContain("1 of the 3 visits couldn't be found");
	});

	it("paces a long series delete in batches without dropping any (9 visits)", async () => {
		// Nine ids cross the batch-of-8 pause (deletePause; its sleep is zeroed
		// in tests) — every mockDelete being consumed proves all nine ran.
		const ids = [51, 52, 53, 54, 55, 56, 57, 58, 59];
		for (const id of ids) mockDelete(id);
		let respond: any;
		mockRespond((b) => (respond = b), 2);

		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor", "trig-del", {
					value: JSON.stringify({ ids }),
					responseUrl: `${RESPOND_BASE}/respond`,
					messageText: "✅ *Visitor registered*\n*Name:* Jane Doe",
				}),
			),
		);
		expect(res.status).toBe(200);
		expect(respond.replace_original).toBe(true);
		expect(respond.text).toContain("🗑️ *Registration deleted*");
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

	it("confirms ephemerally too when the row click carries no block_id", async () => {
		mockDelete(43);
		let respond: any;
		mockRespond((b) => (respond = b));

		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("delete_visitor_row", "trig-del", {
					value: JSON.stringify({ id: 43 }),
					responseUrl: `${RESPOND_BASE}/respond`,
					messageBlocks: seriesBlocks(),
				}),
			),
		);
		expect(res.status).toBe(200);
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
