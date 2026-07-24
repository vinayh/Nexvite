/**
 * Pure time and calendar helpers: wall-clock ↔ instant conversion in a named
 * timezone, and expansion of a repeat cadence into the series' visit dates.
 * No Slack or Nexudus knowledge — everything here is trivially unit-testable.
 */

// A visit either doesn't repeat (the modal's "Repeat until" left blank) or
// repeats weekly — every N weeks on chosen days, up to that inclusive end
// date. Daily is weekly with every day selected; one repeat shape instead of
// three. Expansion steps through calendar dates in SPACE_TIMEZONE date space;
// every occurrence keeps the first visit's wall-clock time. Nexudus has no
// recurrence field — a repeating visit is just one visitor object per date in
// a single create request (README) — so a series is capped like the Nexudus
// portal's own "up to 30 visits in one go".
export const MAX_VISITS = 30;
export const MAX_INTERVAL = 99;

// The days a weekly repeat visits (the modal's multi-select, required while
// repeating and preselected with the first visit's weekday). Weeks start on
// Monday.
export const WEEKDAYS = {
	mon: { label: "Monday", short: "Mon" },
	tue: { label: "Tuesday", short: "Tue" },
	wed: { label: "Wednesday", short: "Wed" },
	thu: { label: "Thursday", short: "Thu" },
	fri: { label: "Friday", short: "Fri" },
	sat: { label: "Saturday", short: "Sat" },
	sun: { label: "Sunday", short: "Sun" },
} as const;
export type WeekdayKey = keyof typeof WEEKDAYS;
const DAY_ORDER = Object.keys(WEEKDAYS) as WeekdayKey[];

// The summary's cadence wording: "Every week", "Every 2 weeks on Mon, Thu".
export function repeatLabel(every: number, days?: WeekdayKey[]): string {
	const base = every === 1 ? "Every week" : `Every ${every} weeks`;
	if (!days?.length) return base;
	const sorted = DAY_ORDER.filter((d) => days.includes(d));
	return `${base} on ${sorted.map((d) => WEEKDAYS[d].short).join(", ")}`;
}

// Epoch seconds → naive "YYYY-MM-DDTHH:mm:ss" in `timeZone` (no offset suffix).
export function toWallClock(epochSeconds: number, timeZone: string): string {
	const wallClock = new Intl.DateTimeFormat("sv-SE", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date(epochSeconds * 1000));
	return wallClock.replace(" ", "T");
}

// Inverse of toWallClock: naive "YYYY-MM-DDTHH:mm:ss" read as `timeZone`
// wall-clock → epoch seconds. Start from the UTC reading, then correct by the
// round-trip error; the second pass settles values near a DST transition. A
// wall-clock skipped by spring-forward resolves to a nearby real instant.
export function fromWallClock(wallClock: string, timeZone: string): number {
	const target = Date.parse(`${wallClock}Z`) / 1000;
	let epoch = target;
	for (let i = 0; i < 2; i++) {
		epoch += target - Date.parse(`${toWallClock(epoch, timeZone)}Z`) / 1000;
	}
	return epoch;
}

// ---------------------------------------------------------------------------
// Repeat expansion
// ---------------------------------------------------------------------------
//
// Calendar math over naive "YYYY-MM-DD" strings is timezone-free, so the
// series is expanded in date space and only the final date+time wall-clocks
// are converted to instants (per occurrence, so DST changes mid-series keep
// the space-local time).

function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

// Days since Monday for a naive date, matching DAY_ORDER (Mon = 0).
function weekdayIndex(date: string): number {
	return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

// The weekday of a naive date, e.g. "2030-07-20" → "sat".
export function weekdayOf(date: string): WeekdayKey {
	return DAY_ORDER[weekdayIndex(date)];
}

// Candidate visit dates, ascending and unbounded; the caller stops at `until`
// or the visit cap. Each active week's selected days are walked (Monday-based
// weeks anchored on the first visit's week), so the first visit is the first
// chosen day on or after the arrival date.
function* occurrences(firstDate: string, interval: number, days: WeekdayKey[]): Generator<string> {
	const offsets = DAY_ORDER.flatMap((d, i) => (days.includes(d) ? [i] : []));
	const weekStart = addDays(firstDate, -weekdayIndex(firstDate));
	for (let week = 0; ; week++) {
		for (const offset of offsets) {
			const date = addDays(weekStart, week * interval * 7 + offset);
			if (date >= firstDate) yield date;
		}
	}
}

// Expand the repeat fields into visit dates (ascending; the arrival date
// itself unless the day choice skips it) or an inline error naming the
// offending form field (the caller maps the field key to its Slack block id).
// A blank `until` is a single visit — the repeat fields only apply once an
// end date is chosen, so a crafted interval or day list without one is
// ignored, not an error. `every` is the interval in weeks, already resolved
// by the caller (a blank field reads as 1 there); `days` defaults to the
// first visit's weekday (the modal requires a choice, so only crafted
// payloads omit it); `until` is the inclusive last-possible date. ISO date
// strings compare correctly as strings.
export function expandRepeat(
	firstDate: string,
	opts: { every: number; days?: WeekdayKey[]; until?: string },
): { dates: string[] } | { field: "repeatEvery" | "repeatUntil"; error: string } {
	const { every: interval, until } = opts;
	if (!until) return { dates: [firstDate] };
	if (interval < 1 || interval > MAX_INTERVAL) {
		return { field: "repeatEvery", error: `Repeat every 1 to ${MAX_INTERVAL} weeks.` };
	}
	if (until < firstDate) {
		return { field: "repeatUntil", error: "The repeat ends before the first visit — pick a later date." };
	}
	const days = opts.days?.length ? opts.days : [weekdayOf(firstDate)];
	const dates: string[] = [];
	for (const date of occurrences(firstDate, interval, days)) {
		if (date > until) break;
		dates.push(date);
		if (dates.length > MAX_VISITS) {
			return { field: "repeatUntil", error: `That's more than ${MAX_VISITS} visits — pick an earlier end date.` };
		}
	}
	// Possible only with day choices: no chosen day falls in the window.
	if (!dates.length) {
		return { field: "repeatUntil", error: "No chosen day falls before the end date — pick a later date or other days." };
	}
	return { dates };
}
