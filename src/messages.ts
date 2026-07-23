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
import { MAX_VISITS, REPEATS, toWallClock, type RepeatKey } from "./time";

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
	repeat: { block: "repeat", action: "value" },
	repeatUntil: { block: "repeat_until", action: "value" },
	host: { block: "host", action: "value", cap: 200 },
	notes: { block: "notes", action: "value", cap: 1000 },
} as const;

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

function inputBlock(block: string, action: string, label: string, element: Record<string, unknown>, optional = false, hint?: string) {
	return {
		type: "input",
		block_id: block,
		optional,
		label: { type: "plain_text", text: label },
		element: { action_id: action, ...element },
		...(hint && { hint: { type: "plain_text", text: hint } }),
	};
}

function repeatOption(key: RepeatKey) {
	return { text: { type: "plain_text", text: REPEATS[key].label }, value: key };
}

export function visitorModal(env: Env) {
	return {
		type: "modal",
		callback_id: CALLBACK_ID,
		title: { type: "plain_text", text: "Register a visitor" },
		submit: { type: "plain_text", text: "Register" },
		close: { type: "plain_text", text: "Cancel" },
		blocks: [
			inputBlock(FIELDS.fullName.block, FIELDS.fullName.action, "Full name", {
				type: "plain_text_input",
			}),
			inputBlock(FIELDS.email.block, FIELDS.email.action, "Email", { type: "email_text_input" }),
			inputBlock(FIELDS.phone.block, FIELDS.phone.action, "Phone", { type: "plain_text_input" }, true),
			// Naive date + time pickers, not a datetimepicker: a datetimepicker
			// renders in each member's own timezone, so the instant it submits
			// depends on who submitted it. These values are read as SPACE_TIMEZONE
			// wall-clock; the labels name that timezone because for a member
			// abroad the field is *not* their local time.
			inputBlock(FIELDS.arrivalDate.block, FIELDS.arrivalDate.action, `Expected arrival — date (${env.SPACE_TIMEZONE})`, {
				type: "datepicker",
			}),
			inputBlock(
				FIELDS.arrivalTime.block,
				FIELDS.arrivalTime.action,
				`Expected arrival — time (${env.SPACE_TIMEZONE})`,
				{ type: "timepicker" },
				false,
				`Time at the space (${env.SPACE_TIMEZONE}), not your own time zone.`,
			),
			// Repeat cadence + inclusive end date; the arrival above is the first
			// visit. "Repeat until" must be optional so Slack doesn't demand it on
			// single-visit submissions; picking a cadence without it is bounced
			// with an inline error instead.
			inputBlock(FIELDS.repeat.block, FIELDS.repeat.action, "Repeat visit", {
				type: "static_select",
				initial_option: repeatOption("none"),
				options: (Object.keys(REPEATS) as RepeatKey[]).map(repeatOption),
			}),
			inputBlock(
				FIELDS.repeatUntil.block,
				FIELDS.repeatUntil.action,
				`Repeat until (${env.SPACE_TIMEZONE})`,
				{ type: "datepicker" },
				true,
				`Last possible visit date when repeating — up to ${MAX_VISITS} visits.`,
			),
			inputBlock(FIELDS.host.block, FIELDS.host.action, "Who are they visiting?", { type: "plain_text_input" }, true),
			inputBlock(FIELDS.notes.block, FIELDS.notes.action, "Notes", { type: "plain_text_input", multiline: true }, true),
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

// mrkdwn summary of what was submitted, shown under every result header (and in
// the channel log). Blank optional fields are omitted; arrival is space-local
// (the first visit when repeating).
export function submissionSummary(env: Env, input: VisitorInput): string {
	const lines: string[] = [];
	if (input.fullName) lines.push(`*Name:* ${mrkdwnEscape(input.fullName)}`);
	if (input.email) lines.push(`*Email:* ${mrkdwnEscape(input.email)}`);
	if (input.phone) lines.push(`*Phone:* ${mrkdwnEscape(input.phone)}`);
	if (input.arrivalEpochs?.length) lines.push(`*Arrival:* ${spaceTime(env, input.arrivalEpochs[0])}`);
	if (input.repeat) {
		const { label, until, count } = input.repeat;
		lines.push(`*Repeats:* ${label} until ${until} (${count} visit${count === 1 ? "" : "s"})`);
	}
	if (input.host) lines.push(`*Visiting:* ${mrkdwnEscape(input.host)}`);
	if (input.notes) lines.push(`*Notes:* ${mrkdwnEscape(input.notes)}`);
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
			return /^\*(Name|Email|Phone|Arrival|Repeats|Visiting|Notes|Visit \d+):\*/.test(line) ? `~${line}~` : line;
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
