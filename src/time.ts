/**
 * Pure time and calendar helpers: wall-clock ↔ instant conversion in a named
 * timezone, and expansion of a repeat cadence into the series' visit dates.
 * No Slack or Nexudus knowledge — everything here is trivially unit-testable.
 */

// The cadences offered by the modal's "Repeat visit" select. Expansion steps
// through calendar dates in SPACE_TIMEZONE date space; every occurrence keeps
// the first visit's wall-clock time. Nexudus has no recurrence field — a
// repeating visit is just one visitor object per date in a single create
// request (README) — so a series is capped like the Nexudus portal's own
// "up to 30 visits in one go".
export const REPEATS = {
	none: { label: "Does not repeat", stepDays: 0 },
	daily: { label: "Every day", stepDays: 1 },
	weekdays: { label: "Every weekday (Mon–Fri)", stepDays: 1 },
	weekly: { label: "Every week", stepDays: 7 },
	fortnightly: { label: "Every 2 weeks", stepDays: 14 },
} as const;
export type RepeatKey = keyof typeof REPEATS;
export const MAX_VISITS = 30;

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

function isWeekend(date: string): boolean {
	const day = new Date(`${date}T00:00:00Z`).getUTCDay();
	return day === 0 || day === 6;
}

// Expand the repeat selection into visit dates (first date included, ascending)
// or an inline error naming the offending form field (the caller maps the
// field key to its Slack block id). `until` is inclusive; ISO date strings
// compare correctly as strings.
export function expandRepeat(
	firstDate: string,
	repeat: RepeatKey,
	until: string | undefined,
): { dates: string[] } | { field: "repeat" | "repeatUntil"; error: string } {
	if (repeat === "none") return { dates: [firstDate] };
	if (!until) {
		return { field: "repeatUntil", error: "Pick the last visit date for the repeat." };
	}
	if (until < firstDate) {
		return { field: "repeatUntil", error: "The repeat ends before the first visit — pick a later date." };
	}
	if (repeat === "weekdays" && isWeekend(firstDate)) {
		return { field: "repeat", error: "The first visit falls on a weekend — pick a weekday arrival date to repeat on weekdays." };
	}
	const dates: string[] = [];
	for (let date = firstDate; date <= until; date = addDays(date, REPEATS[repeat].stepDays)) {
		if (repeat === "weekdays" && isWeekend(date)) continue;
		dates.push(date);
		if (dates.length > MAX_VISITS) {
			return { field: "repeatUntil", error: `That's more than ${MAX_VISITS} visits — pick an earlier end date.` };
		}
	}
	return { dates };
}
