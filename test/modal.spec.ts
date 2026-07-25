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
		// Three divider-set groups: the visitor, the schedule, context.
		expect(blockIds).toEqual([
			"full_name",
			"email",
			"phone",
			"visitor_divider",
			"arrival_date",
			"arrival_time",
			"repeat_until",
			"schedule_divider",
			"host",
			"notes",
		]);
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
		// A blank "Repeat until" is the no-repeat default, so the single-visit
		// flow needs no interaction; the interval and day fields only appear
		// once an end date is picked (the picker dispatches its changes so the
		// handler can re-render).
		expect(byId.repeat_until.label.text).toBe("Repeat until [BETA]");
		expect(byId.repeat_until.optional).toBe(true);
		expect(byId.repeat_until.dispatch_action).toBe(true);
		expect(byId.repeat_until.hint.text).toBe("Europe/London — leave blank for a single visit");
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

	it("re-renders the modal with the repeat fields when an end date is picked, and without them when unset", async () => {
		let update: any;
		mockSlack("views.update", (b) => (update = b));
		const res = await run(
			await slackRequest(
				"/slack/interactivity",
				blockActionsBody("repeat_until", "trig-xyz", {
					selectedDate: "2030-08-20",
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
			"phone",
			"visitor_divider",
			"arrival_date",
			"arrival_time",
			"repeat_until",
			"repeat_days",
			"repeat_every",
			"schedule_divider",
			"host",
			"notes",
		]);
		// Both revealed fields are required but prefilled — the interval starts
		// at 1 with just the unit as its hint, and the single-row day
		// multi-select is preselected with the weekday of the arrival date
		// already in the form (2030-07-20 is a Saturday) — so the common case
		// needs no interaction.
		expect(byId.repeat_every.optional).toBe(false);
		expect(byId.repeat_every.element.initial_value).toBe("1");
		expect(byId.repeat_every.hint.text).toBe("week(s)");
		expect(byId.repeat_days.optional).toBe(false);
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
		expect(byId.repeat_days.element.initial_options).toEqual([{ text: { type: "plain_text", text: "Saturday" }, value: "sat" }]);

		// Without an arrival date in the form state, no day preselection.
		let bare: any;
		mockSlack("views.update", (b) => (bare = b));
		await run(
			await slackRequest("/slack/interactivity", blockActionsBody("repeat_until", "trig-xyz", { selectedDate: "2030-08-20", viewId: "V1" })),
		);
		expect(bare.view.blocks.find((b: any) => b.block_id === "repeat_days").element.initial_options).toBeUndefined();

		// A dispatch without a date (the picker unset) drops the repeat fields.
		let revert: any;
		mockSlack("views.update", (b) => (revert = b));
		await run(await slackRequest("/slack/interactivity", blockActionsBody("repeat_until", "trig-xyz", { viewId: "V1" })));
		expect(revert.view.blocks.map((b: any) => b.block_id)).toEqual([
			"full_name",
			"email",
			"phone",
			"visitor_divider",
			"arrival_date",
			"arrival_time",
			"repeat_until",
			"schedule_divider",
			"host",
			"notes",
		]);
	});

	it("tells the user to retry if views.open fails, still 200", async () => {
		mockUserInfo(); // the host-prefill lookup that precedes views.open
		mockSlack("views.open", undefined, { ok: false, error: "expired_trigger_id" });
		const res = await run(await slackRequest("/slack/command", COMMAND_BODY));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Couldn't open");
	});

	it("tells the user to retry when Slack answers views.open with a non-JSON body", async () => {
		// e.g. an HTML error page from a proxy: the transport must degrade to a
		// failed call, not throw on the parse.
		mockUserInfo();
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
