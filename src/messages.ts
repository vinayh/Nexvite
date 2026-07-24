/**
 * Everything the member sees, as pure builders (no network calls): the
 * registration modal, the post-submission status modal, the App Home tab, the
 * mrkdwn summaries and Block Kit for the result messages, and the restyling
 * of a ✅ confirmation into its 🗑️ deleted form.
 *
 * The restyle functions mirror the builders line-for-line (deletedFromMessage
 * matches the field labels submissionSummary writes), which is why they live
 * in the same module — change a label in one place and its counterpart is on
 * the same screen.
 */

import { mrkdwnEscape, type SlackMessage } from "./slack";
import { MAX_INTERVAL, REPEAT_UNITS, WEEKDAYS, toWallClock, type RepeatKey, type WeekdayKey } from "./time";

export const CALLBACK_ID = "visitor_registration";
export const OPEN_ACTION = "open_visitor_form"; // the Home-tab button that opens the modal
export const DELETE_ACTION = "delete_visitor"; // button on the ✅ confirmation messages (single visit / whole series)
export const DELETE_ROW_ACTION = "delete_visitor_row"; // per-visit button on a series ✅ message's rows

// Modal block/action ids, used to read each value from view.state.values.
export const FIELDS = {
	fullName: { block: "full_name", action: "value", cap: 200 },
	email: { block: "email", action: "value", cap: 320 },
	phone: { block: "phone", action: "value", cap: 50 },
	arrivalDate: { block: "arrival_date", action: "value" },
	arrivalTime: { block: "arrival_time", action: "value" },
	// The repeat select's action_id doubles as the block_actions dispatch id
	// (changing it re-renders the modal), so it's distinct from "value".
	repeat: { block: "repeat", action: "repeat_unit" },
	repeatEvery: { block: "repeat_every", action: "value" },
	repeatDays: { block: "repeat_days", action: "value" },
	repeatUntil: { block: "repeat_until", action: "value" },
	host: { block: "host", action: "value", cap: 200 },
	notes: { block: "notes", action: "value", cap: 1000 },
} as const;

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

function inputBlock(
	block: string,
	action: string,
	label: string,
	element: Record<string, unknown>,
	opts: { optional?: boolean; hint?: string; dispatch?: boolean } = {},
) {
	return {
		type: "input",
		block_id: block,
		optional: opts.optional ?? false,
		...(opts.dispatch && { dispatch_action: true }),
		label: { type: "plain_text", text: label },
		element: { action_id: action, ...element },
		...(opts.hint && { hint: { type: "plain_text", text: opts.hint } }),
	};
}

function repeatOption(key: RepeatKey) {
	return { text: { type: "plain_text", text: REPEAT_UNITS[key].label }, value: key };
}

// `repeat` is the currently selected unit: the select dispatches its changes
// and the handler re-renders the modal, so the interval and end fields only
// exist while a repeat is chosen (views.update keeps the values of the blocks
// that survive, matched by block_id — including a `host` prefill the member
// typed over, so the re-render doesn't need to know it). `untilInitial` seeds
// the "Ends on" picker with the arrival date already in the form: Slack can't
// cross-validate pickers client-side, so this only starts it on a valid date;
// the real on/after check is the inline error at submission.
export function visitorModal(env: Env, repeat: RepeatKey = "none", host?: string, untilInitial?: string) {
	const repeatFields =
		repeat === "none"
			? []
			: [
					inputBlock(
						FIELDS.repeatEvery.block,
						FIELDS.repeatEvery.action,
						"Repeat every",
						{ type: "number_input", is_decimal_allowed: false, min_value: "1", max_value: String(MAX_INTERVAL) },
						{
							optional: true,
							hint: `How many ${REPEAT_UNITS[repeat].noun}s between visits — leave blank for every ${REPEAT_UNITS[repeat].noun}`,
						},
					),
					// Weekly repeats can pick the days to visit within each active week.
					// A multi-select, not checkboxes: it renders as a single row (picked
					// days become inline tokens) where checkboxes stack vertically. Its
					// state arrives as selected_options, same as checkboxes.
					...(repeat === "week"
						? [
								inputBlock(
									FIELDS.repeatDays.block,
									FIELDS.repeatDays.action,
									"Repeats on",
									{
										type: "multi_static_select",
										placeholder: { type: "plain_text", text: "Select days" },
										options: (Object.keys(WEEKDAYS) as WeekdayKey[]).map((day) => ({
											text: { type: "plain_text", text: WEEKDAYS[day].label },
											value: day,
										})),
									},
									{ optional: true, hint: "Days of the week to visit — leave blank for the arrival date's weekday" },
								),
							]
						: []),
					// Required: this block only exists while a repeat is chosen, so
					// Slack itself demands it before the modal can submit (up to
					// MAX_VISITS visits; over is bounced with an inline error).
					inputBlock(
						FIELDS.repeatUntil.block,
						FIELDS.repeatUntil.action,
						"Ends on",
						{ type: "datepicker", ...(untilInitial && { initial_date: untilInitial }) },
						{ hint: env.SPACE_TIMEZONE },
					),
				];
	return {
		type: "modal",
		callback_id: CALLBACK_ID,
		title: { type: "plain_text", text: "Register a visitor" },
		submit: { type: "plain_text", text: "Register" },
		close: { type: "plain_text", text: "Cancel" },
		blocks: [
			inputBlock(FIELDS.fullName.block, FIELDS.fullName.action, "Visitor name", {
				type: "plain_text_input",
			}),
			inputBlock(FIELDS.email.block, FIELDS.email.action, "Visitor email", { type: "email_text_input" }),
			// Naive date + time pickers, not a datetimepicker: a datetimepicker
			// renders in each member's own timezone, so the instant it submits
			// depends on who submitted it. These values are read as SPACE_TIMEZONE
			// wall-clock; the bare timezone hint under each field says so, because
			// for a member abroad the field is *not* their local time.
			inputBlock(FIELDS.arrivalDate.block, FIELDS.arrivalDate.action, "Arrival date", { type: "datepicker" }, { hint: env.SPACE_TIMEZONE }),
			inputBlock(
				FIELDS.arrivalTime.block,
				FIELDS.arrivalTime.action,
				"Arrival time",
				{ type: "timepicker" },
				{ hint: env.SPACE_TIMEZONE },
			),
			// Everything below the line is fine to leave as-is for the common case.
			{ type: "divider", block_id: "divider" },
			// Required, but prefilled with the opener's own name, so the common
			// case (registering your own guest) needs no typing.
			inputBlock(FIELDS.host.block, FIELDS.host.action, "Person they are visiting", {
				type: "plain_text_input",
				...(host && { initial_value: host }),
			}),
			// The Nexudus portal's repeat model: every N days/weeks/months on
			// chosen days, up to an end date. The arrival above is the first
			// visit; choosing a unit unfolds the detail fields right below.
			// Bracketing dividers set the repeat fields off as their own section
			// (a modal has no stronger grouping than a divider).
			{ type: "divider", block_id: "repeat_divider" },
			inputBlock(
				FIELDS.repeat.block,
				FIELDS.repeat.action,
				"Repeat visit",
				{
					type: "static_select",
					initial_option: repeatOption(repeat),
					options: (Object.keys(REPEAT_UNITS) as RepeatKey[]).map(repeatOption),
				},
				{ dispatch: true },
			),
			...repeatFields,
			{ type: "divider", block_id: "repeat_end_divider" },
			inputBlock(FIELDS.phone.block, FIELDS.phone.action, "Visitor phone", { type: "plain_text_input" }, { optional: true }),
			inputBlock(FIELDS.notes.block, FIELDS.notes.action, "Notes", { type: "plain_text_input", multiline: true }, { optional: true }),
		],
	};
}

// The post-submission modal: a single-message view, no inputs. Shown first as a
// "⏳ registering" placeholder (returned inline via response_action:update on the
// submission), then swapped for the ✅/❌/⚠️ result via views.update once Nexudus
// responds. It's live feedback only; the DM (and its Delete button) is the
// durable record, so closing the window loses nothing.
export function statusModal(text: string) {
	return {
		type: "modal",
		title: { type: "plain_text", text: "Visitor registration" }, // ≤24 chars
		close: { type: "plain_text", text: "Close" },
		blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
	};
}

// Placeholder shown on submission while registration runs in the background.
export function registeringText(visitCount: number): string {
	const head = visitCount > 1 ? `⏳ *Registering ${visitCount} visits…*` : "⏳ *Registering your visitor…*";
	return `${head}\nThis usually takes a few seconds. You'll get a direct message with the result — you can close this window any time.`;
}

// The App Home tab: the button entry point for every workspace user. The tab
// can't open a modal itself, but its button click arrives as block_actions with
// a trigger_id (what views.open needs).
export function homeView() {
	return {
		type: "home",
		blocks: [
			{ type: "header", text: { type: "plain_text", text: "Visitor registration" } },
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "Expecting a guest? Register them so reception knows they're coming. You can also run `/visitor` from any channel.",
				},
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Register a visitor" },
						style: "primary",
						action_id: OPEN_ACTION,
					},
				],
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Result messages (summary + blocks)
// ---------------------------------------------------------------------------

// Space-local, minute-granular rendering of an instant (like the modal
// pickers), e.g. "2026-07-20 15:30 (Europe/London)".
export function spaceTime(env: Env, epochSeconds: number): string {
	const local = toWallClock(epochSeconds, env.SPACE_TIMEZONE).replace("T", " ").slice(0, 16);
	return `${local} (${env.SPACE_TIMEZONE})`;
}

export interface VisitorInput {
	fullName?: string;
	email?: string;
	phone?: string;
	arrivalEpochs?: number[]; // ascending; single-element when not repeating
	repeat?: { label: string; until: string; count: number }; // set when repeating; until is the last visit's date
	host?: string;
	notes?: string;
	submittedBy: string;
}

// The visitor's own field labels, matching the modal's wording: written by
// submissionSummary and struck by the 🗑️ restyle below. Keeping the list here
// (typed into both) means a new summary field strikes correctly on deletion by
// construction. "Submitted by" and "Nexudus ID" are deliberately absent so
// they survive the restyle.
const SUMMARY_LABELS = ["Visitor name", "Visitor email", "Visitor phone", "Arrival", "Repeats", "Visiting", "Notes"] as const;
// Labels older ✅ messages were posted with; their Delete buttons still work,
// so the restyle must keep striking them.
const LEGACY_LABELS = ["Name", "Email", "Phone"] as const;
const STRUCK_LINE = new RegExp(`^\\*(${[...SUMMARY_LABELS, ...LEGACY_LABELS].join("|")}|Visit \\d+):\\*`);

// mrkdwn summary of what was submitted, shown under every result header (and in
// the channel log). Blank optional fields are omitted; arrival is space-local
// (the first visit when repeating).
export function submissionSummary(env: Env, input: VisitorInput): string {
	const { repeat } = input;
	const fields: Record<(typeof SUMMARY_LABELS)[number], string | undefined> = {
		"Visitor name": input.fullName && mrkdwnEscape(input.fullName),
		"Visitor email": input.email && mrkdwnEscape(input.email),
		"Visitor phone": input.phone && mrkdwnEscape(input.phone),
		Arrival: input.arrivalEpochs?.length ? spaceTime(env, input.arrivalEpochs[0]) : undefined,
		Repeats: repeat && `${repeat.label} until ${repeat.until} (${repeat.count} visit${repeat.count === 1 ? "" : "s"})`,
		Visiting: input.host && mrkdwnEscape(input.host),
		Notes: input.notes && mrkdwnEscape(input.notes),
	};
	const lines = SUMMARY_LABELS.filter((label) => fields[label]).map((label) => `*${label}:* ${fields[label]}`);
	lines.push(`*Submitted by:* ${mrkdwnEscape(input.submittedBy)}`);
	return lines.join("\n");
}

// Top line of the ✅ confirmation; dropped from the 🗑️ message on deletion.
// Nexudus emails a separate invite (with its own PIN/QR) per visit, so the
// series variant says so — otherwise one invite per visit looks like a bug.
export const INVITE_NOTE = "_The visitor should receive an invite from the Nexudus platform shortly at the email below._";
export const SERIES_INVITE_NOTE = "_The visitor should receive a separate Nexudus invite at the email below for each visit in the series._";

// The delete buttons' payload: the Nexudus Id(s) captured at registration,
// which the click handlers delete directly (README, delete flow). Single
// visits and per-visit rows use the `{id}` shape (so older single-visit
// messages' buttons still work); a series' Delete-all button carries `{ids}`.
export interface DeleteRef {
	id?: number;
	ids?: number[];
}

function deleteButton(label: string, ref: DeleteRef, actionId: string, confirmText: string) {
	return {
		type: "button",
		text: { type: "plain_text", text: label },
		style: "danger",
		action_id: actionId,
		value: JSON.stringify(ref),
		confirm: {
			title: { type: "plain_text", text: "Delete?" },
			text: { type: "plain_text", text: confirmText },
			confirm: { type: "plain_text", text: "Delete" },
			deny: { type: "plain_text", text: "Keep" },
		},
	};
}

// Single-visit ✅ blocks: the summary plus a Delete button.
export function successBlocks(text: string, ref: DeleteRef): unknown[] {
	return [
		{ type: "section", text: { type: "mrkdwn", text } },
		{ type: "actions", elements: [deleteButton("Delete registration", ref, DELETE_ACTION, "The visitor will be removed from Nexudus.")] },
	];
}

// Series ✅ blocks: the summary section, then one row per visit with its own
// Delete accessory (strikes just that row), then a Delete-all button. 30 rows
// + head + actions stays well under Slack's 50-block message cap. The row's
// block_id carries the visit's Nexudus Id so the click handler can find and
// restyle exactly the clicked row.
export function seriesSuccessBlocks(headText: string, rows: { id: number; line: string }[]): unknown[] {
	return [
		{ type: "section", text: { type: "mrkdwn", text: headText } },
		...rows.map((row) => ({
			type: "section",
			block_id: `visit_${row.id}`,
			text: { type: "mrkdwn", text: row.line },
			accessory: deleteButton("Delete", { id: row.id }, DELETE_ROW_ACTION, "This visit will be removed from Nexudus."),
		})),
		{
			type: "actions",
			elements: [
				deleteButton(
					`Delete all ${rows.length} registrations`,
					{ ids: rows.map((row) => row.id) },
					DELETE_ACTION,
					`All ${rows.length} visits will be removed from Nexudus.`,
				),
			],
		},
	];
}

// ---------------------------------------------------------------------------
// Restyling a ✅ confirmation into its 🗑️ deleted form
// ---------------------------------------------------------------------------

// The 🗑️ confirmation is the clicked ✅ message restyled: header swapped, the
// visitor's own fields struck, invite note dropped. Reusing the message keeps
// the Submitted-by and Nexudus ID lines (and any the list API omits), which is
// safe because delete-by-Id matched this exact record. Empty text yields the
// bare header; unrecognized lines pass through unchanged.
function deletedFromMessage(messageText: string | undefined): string {
	if (!messageText) return "🗑️ *Registration deleted*";
	return messageText
		.split("\n")
		.filter((line) => line !== INVITE_NOTE && line !== SERIES_INVITE_NOTE) // the invite no longer applies
		.map((line) => {
			// Match on the header text, not the leading ✅: Slack fully qualifies the
			// emoji on round-trip (appends a variation selector), so === would miss.
			if (line.includes("*Visitor registered*")) return "🗑️ *Registration deleted*";
			if (line.startsWith("~")) return line; // a row already struck by its own Delete
			return STRUCK_LINE.test(line) ? `~${line}~` : line;
		})
		.join("\n");
}

type SectionBlock = { type?: string; block_id?: unknown; text?: { text?: unknown }; accessory?: unknown };

// Restyle the whole clicked message for the single/Delete-all path: every
// section's lines run through deletedFromMessage's rules; accessories (row
// Delete buttons) and actions blocks are dropped. Falls back to the text-only
// form when the message carries no section blocks.
export function deletedFromBlocks(message?: SlackMessage): { text: string; blocks: unknown[] } {
	const restyled = (message?.blocks ?? []).flatMap((raw) => {
		const block = raw as SectionBlock;
		if (block.type !== "section" || typeof block.text?.text !== "string") return [];
		return [{ type: "section", text: { type: "mrkdwn", text: deletedFromMessage(block.text.text) } }];
	});
	if (!restyled.length) {
		const text = deletedFromMessage(message?.text);
		return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
	}
	return { text: restyled.map((b) => b.text.text).join("\n"), blocks: restyled };
}

// Strike one visit row in place (per-visit Delete): the row's text is struck
// and its Delete accessory dropped; every other block — the summary, the other
// rows' buttons, the Delete-all actions block — survives, so the rest of the
// series stays deletable. Null when the row can't be found (stale message).
export function strikeRowBlocks(message: SlackMessage | undefined, blockId: string): { text: string; blocks: unknown[] } | null {
	if (!message?.blocks || !blockId) return null;
	let found = false;
	const rebuilt = message.blocks.map((raw) => {
		const block = raw as SectionBlock;
		if (block.type === "section" && block.block_id === blockId && typeof block.text?.text === "string") {
			found = true;
			return { type: "section", block_id: blockId, text: { type: "mrkdwn", text: `~${block.text.text}~` } };
		}
		return raw;
	});
	if (!found) return null;
	const text = rebuilt
		.map((raw) => {
			const block = raw as SectionBlock;
			return block.type === "section" && typeof block.text?.text === "string" ? block.text.text : "";
		})
		.filter(Boolean)
		.join("\n");
	return { text, blocks: rebuilt };
}
