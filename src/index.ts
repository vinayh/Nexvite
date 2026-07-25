/**
 * Backend for the Nexvite Slack app: visitor registration from Slack into
 * Nexudus.
 *
 * /slack/command opens the registration modal, /slack/events publishes the
 * App Home tab (whose button also opens the modal), and /slack/interactivity
 * verifies the signature, acks the submission with a "registering" placeholder
 * modal, registers the visitor in Nexudus in the background, then updates the
 * modal and DMs the result. The DM is the durable record. Flow diagram and
 * design rationale: README.md.
 *
 * This module owns routing and flow orchestration; the pieces live in
 * src/slack.ts (transport + payload readers), src/messages.ts (modal, Home
 * tab, message builders and restyles), src/nexudus.ts (API client and auth),
 * and src/time.ts (wall-clock conversion, repeat expansion).
 *
 * Never log modal values, visitor fields, tokens, or Nexudus/Slack response
 * bodies; visitor PII must not reach Workers Logs. Slack and Nexudus error
 * codes are safe to log.
 */

import {
	CALLBACK_ID,
	DELETE_ACTION,
	DELETE_ROW_ACTION,
	FIELDS,
	INVITE_NOTE,
	OPEN_ACTION,
	SERIES_INVITE_NOTE,
	deletedFromBlocks,
	deletingBlocks,
	homeView,
	registeringText,
	seriesSuccessBlocks,
	spaceTime,
	statusModal,
	strikeRowBlocks,
	submissionSummary,
	successBlocks,
	visitorModal,
	type DeleteRef,
	type VisitorInput,
} from "./messages";
import { createVisitors, deleteVisitorIds, lookupVisitorIds, nexudusContact } from "./nexudus";
import {
	fetchFullName,
	mrkdwnEscape,
	postMessage,
	readDate,
	readMultiSelect,
	readNumber,
	readText,
	readTime,
	respond,
	slackApiWarn,
	verifySlackSignature,
	type SlackMessage,
	type ViewState,
} from "./slack";
import { MAX_VISITS, WEEKDAYS, expandRepeat, fromWallClock, repeatLabel, toWallClock, type WeekdayKey } from "./time";

// Past-arrival grace ("now" rounds down to the minute; slow submits). Older is
// rejected inline; the /my lookup used for confirmation only sees upcoming visits.
const ARRIVAL_GRACE_S = 120;

// Open the modal from a trigger_id (slash command or the Home-tab button
// click), prefilling "Person they are visiting" with the opener's own name
// (usually the member registers their own guest; the field stays editable).
// The users.info lookup falls back to the payload's username, then to no
// prefill — never a reason not to open. A views.open failure is warned with
// the Slack error code (never PII); false lets the slash-command path tell
// the user to retry.
async function openModal(env: Env, triggerId: string, opener?: { id?: string; name?: string }): Promise<boolean> {
	const host = (opener?.id ? await fetchFullName(env, opener.id) : null) ?? opener?.name;
	return slackApiWarn(env, "views.open", { trigger_id: triggerId, view: visitorModal(env, false, host) });
}

// Swap the post-submission placeholder for the result, if the submitter still
// has the modal open. A closed or expired view makes this a no-op (the DM
// already carries the outcome), so a failure here is only logged.
function updateStatusModal(env: Env, viewId: string, text: string): Promise<boolean> {
	return slackApiWarn(env, "views.update", { view_id: viewId, view: statusModal(text) });
}

// (Re)publish the Home tab for one user, on app_home_opened.
function publishHome(env: Env, userId: string): Promise<boolean> {
	return slackApiWarn(env, "views.publish", { user_id: userId, view: homeView() });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

interface RegistrationResult {
	ok: boolean;
	message: string; // DMed to the submitter; also posted to the channel log when ok
	blocks?: unknown[]; // present on success (summary + delete button)
}

// Registers the visitor and builds the result message. Never throws.
async function registerVisitor(env: Env, input: VisitorInput): Promise<RegistrationResult> {
	const summary = submissionSummary(env, input);
	const failed = (reason: string): RegistrationResult => ({
		ok: false,
		message: `❌ *Registration failed*\n${reason}\n${summary}`,
	});

	const { fullName, email } = input;
	if (!fullName || !email || !input.arrivalEpochs?.length) {
		return failed("Full name, email and expected arrival are all required.");
	}
	// Nexudus reads the naive ExpectedArrival as UTC (shown space-local in the
	// portal), so send UTC wall-clock; the summary echoes the space-local time.
	const arrivalUtcs = input.arrivalEpochs.map((epoch) => toWallClock(epoch, "UTC"));

	// All registrations go through one account, so CustomerNotes is reception's
	// only view of who submitted and who the visitor is for.
	const noteLines: string[] = [`Submitted via Slack by ${input.submittedBy}`];
	if (input.host) noteLines.push(`Visiting: ${input.host}`);
	if (input.notes) noteLines.push(input.notes);

	const regRes = await createVisitors(
		env,
		arrivalUtcs.map((arrivalUtc) => ({
			FullName: fullName,
			Email: email,
			PhoneNumber: input.phone,
			ExpectedArrival: arrivalUtc,
			CustomerNotes: noteLines.join("\n"),
		})),
	);
	if (!regRes) {
		return failed(
			`We couldn't connect to the visitor system, so this visitor was not registered. Please try again later — if it keeps failing, contact ${await nexudusContact(env)}.`,
		);
	}
	if (!regRes.ok) {
		const detail = (await regRes.text().catch(() => "")).slice(0, 300);
		return failed(`Nexudus rejected the registration: ${detail ? mrkdwnEscape(detail) : `HTTP ${regRes.status}`}`);
	}

	// The create returns no Ids (README), so confirm by finding each record in
	// the account's own list, which also yields the Ids the Delete button needs.
	// If any visit can't be found the POST may still have landed (whole or in
	// part), so warn softly (DM only, no channel log) and steer away from a
	// blind retry rather than claim success.
	const ids = await lookupVisitorIds(env, email, arrivalUtcs);
	if (ids == null) {
		console.warn("registration unconfirmed; visitor Id lookup left unmatched visits"); // no PII
		return {
			ok: false,
			message:
				`⚠️ *Registration submitted — but not confirmed*\n` +
				`We sent this to the visitor system but couldn't confirm it went through. It may already be registered — before submitting again, please check with ${await nexudusContact(env)} to avoid a duplicate.\n${summary}`,
		};
	}

	if (ids.length === 1) {
		const message = `✅ *Visitor registered*\n${INVITE_NOTE}\n${summary}\n*Nexudus ID:* ${ids[0]}`;
		return { ok: true, message, blocks: successBlocks(message, { id: ids[0] }) };
	}
	// A series lists each visit on its own row (with a per-visit Delete button
	// in the blocks); ids and arrivalEpochs are aligned, both ascending.
	const rows = ids.map((id, i) => ({ id, line: `*Visit ${i + 1}:* ${spaceTime(env, input.arrivalEpochs![i])} · Nexudus ID ${id}` }));
	const head = `✅ *Visitor registered*\n${SERIES_INVITE_NOTE}\n${summary}`;
	const message = [head, ...rows.map((row) => row.line)].join("\n");
	return { ok: true, message, blocks: seriesSuccessBlocks(head, rows) };
}

// ---------------------------------------------------------------------------
// Deletion (the ✅ message's Delete button)
// ---------------------------------------------------------------------------

// Delete the registration(s) by Id and word the outcome. Never throws; the
// clicker always gets feedback. On ok the caller restyles the clicked message
// itself; `note` flags visits that were already gone, `text` is the ephemeral
// warning for failures.
async function deleteVisitors(env: Env, ids: number[]): Promise<{ ok: boolean; note?: string; text?: string }> {
	const { missing, failed } = await deleteVisitorIds(env, ids);
	if (failed === 0 && missing === 0) return { ok: true };

	// Failure contact is the Nexudus account email (see nexudusContact), not
	// the portal, since members can't see these registrations in their own login.
	const contact = await nexudusContact(env);
	if (failed > 0) {
		const done = ids.length - missing - failed;
		const text =
			ids.length === 1
				? `⚠️ Deleting failed — please contact ${contact} to remove the visitor.`
				: `⚠️ Deleted ${done} of ${ids.length} registrations — the rest couldn't be deleted. Please contact ${contact} to remove them.`;
		return { ok: false, text };
	}
	if (missing === ids.length) {
		const text =
			ids.length === 1
				? `⚠️ Couldn't find this registration — it may already be deleted. If it still needs removing, contact ${contact}.`
				: `⚠️ Couldn't find these registrations — they may already be deleted. If they still need removing, contact ${contact}.`;
		return { ok: false, text };
	}
	// Some visits deleted, the rest already gone: the series is fully removed
	// either way, so confirm with a note rather than warn.
	return { ok: true, note: `_${missing} of the ${ids.length} visits couldn't be found — they may already have been deleted._` };
}

// An ephemeral note to just the clicker, leaving the clicked message as-is.
function respondEphemeral(responseUrl: string, text: string | undefined): Promise<void> {
	return respond(responseUrl, { replace_original: false, response_type: "ephemeral", text });
}

// Handle a single/Delete-all click: delete in Nexudus, then on success replace
// the clicked message with its restyled form (every delete button dropped); on
// failure send the clicker an ephemeral note.
//
// A multi-visit series is paced against the Nexudus rate limit, so it takes
// tens of seconds: show the working state first, and put the original message
// back if the delete fails — the placeholder dropped its buttons, and without
// the restore the remaining visits would have no way to be deleted.
async function handleDeleteClick(env: Env, ids: number[], responseUrl: string, message?: SlackMessage): Promise<void> {
	const slow = ids.length > 1;
	if (slow) await respond(responseUrl, { replace_original: true, ...deletingBlocks(message, ids.length) });
	const outcome = await deleteVisitors(env, ids);
	if (!outcome.ok) {
		if (slow && message?.blocks?.length) {
			await respond(responseUrl, { replace_original: true, text: message.text, blocks: message.blocks });
		}
		return respondEphemeral(responseUrl, outcome.text);
	}
	const { text, blocks } = deletedFromBlocks(message);
	const fullText = outcome.note ? `${text}\n${outcome.note}` : text;
	const fullBlocks = outcome.note ? [...blocks, { type: "section", text: { type: "mrkdwn", text: outcome.note } }] : blocks;
	return respond(responseUrl, { replace_original: true, text: fullText, blocks: fullBlocks });
}

// Handle a per-visit Delete click on a series message: delete that one visit,
// then strike just its row in place (other rows and the Delete-all button
// survive). Failure wording matches the single-visit path.
async function handleRowDeleteClick(env: Env, id: number, blockId: string, responseUrl: string, message?: SlackMessage): Promise<void> {
	const outcome = await deleteVisitors(env, [id]);
	if (!outcome.ok) return respondEphemeral(responseUrl, outcome.text);
	const struck = strikeRowBlocks(message, blockId);
	// A stale/foreign message we can't rebuild still gets a truthful ephemeral.
	if (!struck) return respondEphemeral(responseUrl, "🗑️ Visit deleted from Nexudus.");
	return respond(responseUrl, { replace_original: true, ...struck });
}

// A delete button's value is a JSON DeleteRef: `{id}` (single visit or a
// series row) or `{ids}` (a series' Delete-all). Empty on a stale or foreign
// value; capped so a malformed value can't drive an unbounded delete loop.
function parseDeleteIds(value: string): number[] {
	try {
		const parsed = JSON.parse(value) as DeleteRef;
		if (typeof parsed.id === "number") return [parsed.id];
		if (Array.isArray(parsed.ids) && parsed.ids.every((v): v is number => typeof v === "number")) {
			return parsed.ids.slice(0, MAX_VISITS);
		}
	} catch {
		// stale or foreign button value, ignore
	}
	return [];
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type SlackUser = { id?: string; name?: string; username?: string };

// A JSON 200, the shape Slack's interactivity endpoint expects for a
// response_action (here, updating the modal in place on submission).
function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

// Bounce a view_submission with an inline error under one form block.
function fieldError(block: string, message: string): Response {
	return jsonResponse({ response_action: "errors", errors: { [block]: message } });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path !== "/slack/command" && path !== "/slack/interactivity" && path !== "/slack/events") {
			return new Response("Not found", { status: 404 });
		}
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		// Per-IP rate limit, checked before the HMAC work (wrangler.jsonc
		// `ratelimits`). Slack retries a 429ed event, so a burst degrades
		// gracefully. Fails open: losing the limiter must not down the endpoint.
		try {
			const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
			const { success } = await env.RATE_LIMITER.limit({ key: ip });
			if (!success) return new Response("Rate limited", { status: 429 });
		} catch {
			// limiter unavailable, let the request through
		}

		// Read the raw bytes (needed verbatim for the HMAC). Decoding via
		// TextDecoder rather than request.text() avoids workerd's noisy
		// "not text" warning for the application/x-www-form-urlencoded body.
		const rawBody = new TextDecoder().decode(await request.arrayBuffer());
		if (!(await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET))) {
			return new Response("Invalid signature", { status: 401 });
		}

		if (path === "/slack/command") {
			// Slash command: open the modal with the trigger_id (expires in ~3s).
			const params = new URLSearchParams(rawBody);
			const triggerId = params.get("trigger_id");
			if (!triggerId) return new Response("", { status: 200 });

			const opener = { id: params.get("user_id") ?? undefined, name: params.get("user_name") ?? undefined };
			if (!(await openModal(env, triggerId, opener))) {
				return new Response("Couldn't open the visitor form — please try again.", { status: 200 });
			}
			return new Response("", { status: 200 });
		}

		if (path === "/slack/events") {
			// Events API (application/json). The only subscribed event is
			// app_home_opened → (re)publish the Home tab. DMs to the bot are
			// deliberately not an entry point. Ack fast; publish in the background.
			let event: { type?: string; challenge?: string; event?: Record<string, unknown> };
			try {
				event = JSON.parse(rawBody);
			} catch {
				return new Response("", { status: 200 });
			}
			if (event.type === "url_verification") {
				return new Response(event.challenge ?? "", { status: 200 });
			}
			const e = event.event ?? {};
			// tab === "home" only; the event also fires for the Messages tab.
			if (e.type === "app_home_opened" && e.tab === "home" && typeof e.user === "string") {
				ctx.waitUntil(publishHome(env, e.user));
			}
			return new Response("", { status: 200 });
		}

		// path === "/slack/interactivity"
		const payloadRaw = new URLSearchParams(rawBody).get("payload");
		let payload: {
			type?: string;
			user?: SlackUser;
			trigger_id?: string;
			response_url?: string;
			actions?: Array<{
				action_id?: string;
				block_id?: string;
				value?: string;
				selected_date?: string | null; // a dispatched datepicker change
			}>;
			message?: SlackMessage; // present on block_actions from a message (delete-by-Id)
			view?: { id?: string; callback_id?: string; state?: ViewState };
		};
		try {
			payload = JSON.parse(payloadRaw ?? "");
		} catch {
			return new Response("", { status: 200 });
		}

		// Button clicks and dispatched inputs: the Home tab's "Register a visitor"
		// opens the modal; the modal's "Repeat until" picker re-renders the modal
		// so the interval and day fields only show once an end date is chosen; a
		// confirmation's "Delete registration" removes the visitor again. Slack
		// delivers exactly one action per click.
		if (payload.type === "block_actions") {
			const action = payload.actions?.[0];
			if (action?.action_id === OPEN_ACTION && payload.trigger_id) {
				await openModal(env, payload.trigger_id, payload.user);
			} else if (action?.action_id === FIELDS.repeatUntil.action && payload.view?.id) {
				// The day multi-select the re-render unfolds preselects the weekday
				// of the arrival date already entered.
				const arrival = readDate(payload.view.state ?? {}, FIELDS.arrivalDate);
				const repeating = typeof action.selected_date === "string" && action.selected_date.length > 0;
				await slackApiWarn(env, "views.update", { view_id: payload.view.id, view: visitorModal(env, repeating, undefined, arrival) });
			} else if (action?.action_id === DELETE_ACTION && action.value && payload.response_url) {
				const ids = parseDeleteIds(action.value);
				if (ids.length) {
					ctx.waitUntil(handleDeleteClick(env, ids, payload.response_url, payload.message));
				}
			} else if (action?.action_id === DELETE_ROW_ACTION && action.value && payload.response_url) {
				const [id] = parseDeleteIds(action.value);
				if (id != null) {
					ctx.waitUntil(handleRowDeleteClick(env, id, action.block_id ?? "", payload.response_url, payload.message));
				}
			}
			return new Response("", { status: 200 });
		}

		if (payload.type !== "view_submission" || payload.view?.callback_id !== CALLBACK_ID) {
			return new Response("", { status: 200 }); // not ours or not a submission, ack and ignore
		}

		const state = payload.view?.state ?? {};
		const userId = payload.user?.id;
		// The pickers are naive and labeled with SPACE_TIMEZONE in the modal, so the
		// combined wall-clock is read in the space's timezone, not the member's.
		const arrivalDate = readDate(state, FIELDS.arrivalDate);
		const arrivalTime = readTime(state, FIELDS.arrivalTime);
		// A picked "Repeat until" date is what makes the visit repeat; blank (the
		// default) is a single visit and the other repeat fields are ignored. A
		// blank interval reads as 1 here, once; a crafted "0" stays 0 so the
		// range check can bounce it.
		const repeatUntil = readDate(state, FIELDS.repeatUntil);
		const repeatEvery = readNumber(state, FIELDS.repeatEvery) ?? 1;
		// Unrecognized day values (crafted payload) are dropped; an empty result
		// reads as no selection, i.e. the arrival date's weekday. Object.hasOwn,
		// not `in`: a crafted "toString" must not walk the prototype.
		const daysRaw = readMultiSelect(state, FIELDS.repeatDays)?.filter((d): d is WeekdayKey => Object.hasOwn(WEEKDAYS, d));
		const repeatDays = daysRaw?.length ? daysRaw : undefined;

		// Expand the repeat into visit dates, bouncing bad combinations back onto
		// the repeat fields inline. Skipped when the arrival itself is missing
		// (crafted payload); that falls through to the required-fields failure.
		let arrivalEpochs: number[] | undefined;
		let repeatInfo: VisitorInput["repeat"];
		if (arrivalDate && arrivalTime) {
			const expanded = expandRepeat(arrivalDate, { every: repeatEvery, days: repeatDays, until: repeatUntil });
			if ("error" in expanded) {
				return fieldError(FIELDS[expanded.field].block, expanded.error);
			}
			arrivalEpochs = expanded.dates.map((date) => fromWallClock(`${date}T${arrivalTime}:00`, env.SPACE_TIMEZONE));
			if (repeatUntil) {
				// `until` is the last generated visit, not the raw picker value:
				// "every week until Sep 19" may end days earlier.
				const dates = expanded.dates;
				repeatInfo = { label: repeatLabel(repeatEvery, repeatDays), until: dates[dates.length - 1], count: dates.length };
			}
		}
		const input: VisitorInput = {
			fullName: readText(state, FIELDS.fullName),
			email: readText(state, FIELDS.email),
			phone: readText(state, FIELDS.phone),
			arrivalEpochs,
			repeat: repeatInfo,
			host: readText(state, FIELDS.host),
			notes: readText(state, FIELDS.notes),
			submittedBy: payload.user?.name ?? payload.user?.username ?? "a Slack user",
		};

		// Bounce a past first arrival back onto the time field (ARRIVAL_GRACE_S);
		// the series is ascending, so later visits can't be earlier.
		if (input.arrivalEpochs?.length && input.arrivalEpochs[0] < Date.now() / 1000 - ARRIVAL_GRACE_S) {
			return fieldError(
				FIELDS.arrivalTime.block,
				`This time is in the past (${env.SPACE_TIMEZONE}) — pick when the visitor is expected to arrive.`,
			);
		}

		// Register + notify in the background so we ack within Slack's 3s window.
		// The ack itself swaps the modal for a "⏳ registering" placeholder
		// (response_action:update); the background work then updates that same view
		// to the result. The DM remains the durable record if the user closes it.
		if (userId) {
			const viewId = payload.view?.id;
			ctx.waitUntil(
				(async () => {
					// Upgrade the username to the profile's full name when we can.
					input.submittedBy = (await fetchFullName(env, userId)) ?? input.submittedBy;
					const { ok, message, blocks } = await registerVisitor(env, input);
					// Update the open modal first; it's what the submitter is watching.
					if (viewId) await updateStatusModal(env, viewId, message);
					await postMessage(env, userId, message, blocks);
					// Successes also go to the visitors channel, the human-readable
					// log of registrations (VISITOR_CHANNEL; empty disables it).
					// Failures stay in the submitter's DM.
					if (ok && env.VISITOR_CHANNEL) await postMessage(env, env.VISITOR_CHANNEL, message, blocks);
				})(),
			);
			return jsonResponse({ response_action: "update", view: statusModal(registeringText(input.arrivalEpochs?.length ?? 1)) });
		}
		// No user id (shouldn't happen for a real submission), just close the modal.
		return new Response("", { status: 200 });
	},
} satisfies ExportedHandler<Env>;
