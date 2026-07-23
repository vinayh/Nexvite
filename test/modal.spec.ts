// The two entry points to the registration modal: the /visitor slash command
// and the App Home tab's button, plus the events endpoint that publishes the
// Home tab.

import { describe, it, expect } from "vitest";
import { COMMAND_BODY, blockActionsBody, eventBody, mockSlack, run, setupSuite, slackRequest } from "./helpers";

setupSuite();

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
