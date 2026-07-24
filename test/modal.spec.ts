// The two entry points to the registration modal: the /visitor slash command
// and the App Home tab's button, plus the events endpoint that publishes the
// Home tab.

import { fetchMock } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { COMMAND_BODY, SLACK_BASE, blockActionsBody, eventBody, mockSlack, mockUserInfo, run, setupSuite, slackRequest } from "./helpers";

setupSuite();

describe("slash command -> open modal", () => {
	it("opens the visitor modal with the trigger_id, host prefilled with the opener's name, and acks 200", async () => {
		let viewsOpen: any;
		mockUserInfo(); // the opener's users.info lookup for the host prefill
		mockSlack("views.open", (b) => (viewsOpen = b));

		const res = await run(await slackRequest("/slack/command", COMMAND_BODY));
		expect(res.status).toBe(200);
		expect(viewsOpen.trigger_id).toBe("trigger-123");
		expect(viewsOpen.view.callback_id).toBe("visitor_registration");
		const blockIds = viewsOpen.view.blocks.map((b: any) => b.block_id);
		expect(blockIds).toEqual(["full_name", "email", "arrival_date", "arrival_time", "divider", "host", "repeat_divider", "repeat", "repeat_end_divider", "phone", "notes"]);
		const byId = Object.fromEntries(viewsOpen.view.blocks.map((b: any) => [b.block_id, b]));
		// The visitor's own fields say whose details they are.
		expect(byId.full_name.label.text).toBe("Visitor name");
		expect(byId.email.label.text).toBe("Visitor email");
		expect(byId.phone.label.text).toBe("Visitor phone");
		// The pickers are naive and read as SPACE_TIMEZONE wall-clock, so both
		// arrival fields must name the timezone (a bare hint under the field) —
		// a member abroad is not entering their local time.
		expect(byId.arrival_date.label.text).toBe("Arrival date");
		expect(byId.arrival_date.hint.text).toBe("Europe/London");
		expect(byId.arrival_time.label.text).toBe("Arrival time");
		expect(byId.arrival_time.hint.text).toBe("Europe/London");
		// The host is required but defaults to the opener (usually members
		// register their own guest), so the common case needs no typing.
		expect(byId.host.label.text).toBe("Person they are visiting");
		expect(byId.host.element.initial_value).toBe("Vinay Hiremath");
		expect(byId.host.optional).toBe(false);
		// Repeat defaults to "none" so the single-visit flow needs no interaction;
		// the interval and end fields only appear once a repeat is chosen (the
		// select dispatches its changes so the handler can re-render).
		expect(byId.repeat.element.initial_option.value).toBe("none");
		expect(byId.repeat.dispatch_action).toBe(true);
		expect(byId.repeat.element.options.map((o: any) => o.text.text)).toEqual([
			"Does not repeat",
			"Every day",
			"Every week",
			"Every month",
		]);
	});

	it("falls back to the username prefill when users.info fails, and still opens the modal", async () => {
		let viewsOpen: any;
		mockUserInfo({ ok: false, error: "user_not_found" });
		mockSlack("views.open", (b) => (viewsOpen = b));

		const res = await run(await slackRequest("/slack/command", COMMAND_BODY));
		expect(res.status).toBe(200);
		const host = viewsOpen.view.blocks.find((b: any) => b.block_id === "host");
		expect(host.element.initial_value).toBe("vinay"); // COMMAND_BODY's user_name
	});

	it("re-renders the modal with the repeat detail fields when a repeat is chosen, and without them on 'none'", async () => {
		let update: any;
		mockSlack("views.update", (b) => (update = b));
		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("repeat_unit", "trig-xyz", {
					selectedOption: "week",
					viewId: "V1",
					viewState: { arrival_date: { value: { type: "datepicker", selected_date: "2030-07-20" } } },
				}),
			),
		);
		expect(res.status).toBe(200);
		expect(update.view_id).toBe("V1");
		expect(update.view.callback_id).toBe("visitor_registration");
		const byId = Object.fromEntries(update.view.blocks.map((b: any) => [b.block_id, b]));
		expect(update.view.blocks.map((b: any) => b.block_id)).toEqual([
			"full_name",
			"email",
			"arrival_date",
			"arrival_time",
			"divider",
			"host",
			"repeat_divider",
			"repeat",
			"repeat_every",
			"repeat_days",
			"repeat_until",
			"repeat_end_divider",
			"phone",
			"notes",
		]);
		expect(byId.repeat.element.initial_option.value).toBe("week"); // the choice survives the re-render
		// The interval is optional (blank = 1) and its hint names the chosen
		// unit; the weekly day checkboxes are optional (blank = the arrival's
		// weekday); the end date is required — Slack demands it client-side,
		// which is safe because the block only exists while a repeat is chosen —
		// and carries the bare timezone hint like the arrival pickers.
		expect(byId.repeat_every.optional).toBe(true);
		expect(byId.repeat_every.hint.text).toContain("weeks between visits");
		expect(byId.repeat_days.optional).toBe(true);
		// A multi-select renders as a single row, unlike stacked checkboxes; its
		// state arrives as selected_options, so the reader is unchanged.
		expect(byId.repeat_days.element.type).toBe("multi_static_select");
		expect(byId.repeat_days.element.options.map((o: any) => o.value)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
		expect(byId.repeat_days.element.options.map((o: any) => o.text.text)).toEqual([
			"Monday",
			"Tuesday",
			"Wednesday",
			"Thursday",
			"Friday",
			"Saturday",
			"Sunday",
		]);
		expect(byId.repeat_until.optional).toBe(false);
		expect(byId.repeat_until.label.text).toBe("Ends on");
		expect(byId.repeat_until.hint.text).toBe("Europe/London");
		// The picker unfolds starting on the arrival date already in the form
		// (Slack can't cross-validate pickers, so this only seeds a valid
		// default; the on/after check is the inline submission error).
		expect(byId.repeat_until.element.initial_date).toBe("2030-07-20");

		// Without an arrival date in the form state, no seed.
		let bare: any;
		mockSlack("views.update", (b) => (bare = b));
		await run(
			await slackRequest("/slack/interactivity", blockActionsBody("repeat_unit", "trig-xyz", { selectedOption: "week", viewId: "V1" })),
		);
		expect(bare.view.blocks.find((b: any) => b.block_id === "repeat_until").element.initial_date).toBeUndefined();

		// A non-weekly unit gets no day checkboxes.
		let monthly: any;
		mockSlack("views.update", (b) => (monthly = b));
		await run(
			await slackRequest("/slack/interactivity", blockActionsBody("repeat_unit", "trig-xyz", { selectedOption: "month", viewId: "V1" })),
		);
		const monthlyIds = monthly.view.blocks.map((b: any) => b.block_id);
		expect(monthlyIds).toContain("repeat_until");
		expect(monthlyIds).not.toContain("repeat_days");

		// Switching back to "Does not repeat" drops the detail fields again.
		let revert: any;
		mockSlack("views.update", (b) => (revert = b));
		await run(
			await slackRequest("/slack/interactivity", blockActionsBody("repeat_unit", "trig-xyz", { selectedOption: "none", viewId: "V1" })),
		);
		expect(revert.view.blocks.map((b: any) => b.block_id)).toEqual([
			"full_name",
			"email",
			"arrival_date",
			"arrival_time",
			"divider",
			"host",
			"repeat_divider",
			"repeat",
			"repeat_end_divider",
			"phone",
			"notes",
		]);
	});

	it("tells the user to retry if views.open fails, still 200", async () => {
		mockSlack("views.open", undefined, { ok: false, error: "expired_trigger_id" });
		const res = await run(await slackRequest("/slack/command", COMMAND_BODY));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Couldn't open");
	});

	it("tells the user to retry when Slack answers views.open with a non-JSON body", async () => {
		// e.g. an HTML error page from a proxy: the transport must degrade to a
		// failed call, not throw on the parse.
		fetchMock.get(SLACK_BASE).intercept({ path: "/api/views.open", method: "POST" }).reply(200, "<html>gateway error</html>");
		const res = await run(await slackRequest("/slack/command", COMMAND_BODY));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Couldn't open");
	});

	it("acks a slash command that carries no trigger_id (no outbound calls)", async () => {
		const res = await run(await slackRequest("/slack/command", new URLSearchParams({ command: "/visitor" }).toString()));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
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

	it("answers url_verification without a challenge with an empty 200", async () => {
		const res = await run(await slackRequest("/slack/events", JSON.stringify({ type: "url_verification" })));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
	});

	it("acks an event_callback with no event object (no outbound calls)", async () => {
		const res = await run(await slackRequest("/slack/events", JSON.stringify({ type: "event_callback" })));
		expect(res.status).toBe(200);
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

	it("opens the modal when the button is clicked (block_actions), host prefilled like the slash command", async () => {
		let viewsOpen: any;
		mockUserInfo();
		mockSlack("views.open", (b) => (viewsOpen = b));

		const res = await run(await slackRequest("/slack/interactivity", blockActionsBody()));
		expect(res.status).toBe(200);
		expect(viewsOpen.trigger_id).toBe("trig-xyz");
		expect(viewsOpen.view.callback_id).toBe("visitor_registration");
		const host = viewsOpen.view.blocks.find((b: any) => b.block_id === "host");
		expect(host.element.initial_value).toBe("Vinay Hiremath");
	});

	it("acks and ignores block_actions for an unknown action_id (no outbound calls)", async () => {
		const res = await run(await slackRequest("/slack/interactivity", blockActionsBody("some_other_action")));
		expect(res.status).toBe(200);
	});
});
