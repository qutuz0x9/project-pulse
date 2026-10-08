import { moment } from "obsidian";

/**
 * Repeat rules stored in a task's `repeat` property:
 * "daily", "weekdays", "weekly", "monthly", "every 3 days", "every 2 weeks", "every 1 month".
 */
export interface RepeatRule {
	unit: "day" | "week" | "month";
	every: number;
	weekdays: boolean; // "weekdays": skip Saturday and Sunday
}

// Choices offered in the task form (any rule above can also be typed in the note's properties).
export const REPEAT_OPTIONS: [string, string][] = [
	["", "Doesn't repeat"],
	["daily", "Daily"],
	["weekdays", "Weekdays (Mon–Fri)"],
	["weekly", "Weekly"],
	["monthly", "Monthly"],
];

export function parseRepeat(value: unknown): RepeatRule | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	if (v === "daily") return { unit: "day", every: 1, weekdays: false };
	if (v === "weekdays") return { unit: "day", every: 1, weekdays: true };
	if (v === "weekly") return { unit: "week", every: 1, weekdays: false };
	if (v === "monthly") return { unit: "month", every: 1, weekdays: false };
	const m = v.match(/^every\s+(\d+)\s+(day|week|month)s?$/);
	if (m && Number(m[1]) > 0) return { unit: m[2] as RepeatRule["unit"], every: Number(m[1]), weekdays: false };
	return null;
}

/** Short label for chips/badges: "daily", "every 2 weeks". */
export function repeatLabel(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Next due date after `from` (YYYY-MM-DD). If that's already in the past (the task was closed late),
 * keep stepping until it's today or later, so a missed daily task doesn't create a pile of overdue copies.
 */
export function nextDue(from: string, rule: RepeatRule, today: string): string {
	const d = moment(from);
	const step = () => {
		d.add(rule.every, rule.unit);
		if (rule.weekdays) while (d.isoWeekday() > 5) d.add(1, "day");
	};
	step();
	while (d.format("YYYY-MM-DD") < today) step();
	return d.format("YYYY-MM-DD");
}
