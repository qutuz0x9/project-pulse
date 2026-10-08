import { moment } from "obsidian";
import type { Project, TaskPriority } from "./types";

/**
 * One-line task syntax:
 *   Fix login bug tomorrow !high #backend #auth @Food Delivery ~2h *weekly
 *
 *   @project   project name (longest match, so names with spaces work; a unique prefix like @food is enough)
 *   !high      priority: !high / !h, !medium / !m, !low / !l
 *   #tag       category (repeatable)
 *   ~2h ~30m   estimate
 *   *weekly    repeat: *daily, *weekdays, *weekly, *monthly
 *   due date   today, tomorrow, mon…sun (next one), in 3d / in 2w, 2026-10-20
 *   time       14:00, 14:00-16:00, 9am, 2:30pm-4pm → schedules a block on the calendar instead:
 *              the date word (or today) becomes the scheduled day, and no due date is set
 * Everything else is the title.
 */
export interface QuickAddResult {
	title: string;
	project: Project | null;
	priority: TaskPriority | null;
	categories: string[];
	estimate: number | null; // hours
	repeat: string | null;
	due: string | null; // YYYY-MM-DD
	scheduled: string | null; // YYYY-MM-DDTHH:mm when a time was given
	scheduledEnd: string | null;
	errors: string[];
}

const PRIORITY: Record<string, TaskPriority> = { high: "high", h: "high", medium: "medium", med: "medium", m: "medium", low: "low", l: "low" };
const REPEAT = ["daily", "weekdays", "weekly", "monthly"];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export function parseQuickAdd(input: string, projects: Project[], now = moment()): QuickAddResult {
	const r: QuickAddResult = {
		title: "",
		project: null,
		priority: null,
		categories: [],
		estimate: null,
		repeat: null,
		due: null,
		scheduled: null,
		scheduledEnd: null,
		errors: [],
	};
	let time: { start: string; end: string | null } | null = null;
	let text = ` ${input} `;

	// @project — try full names first (longest first) so "@Food Delivery Clone" beats "@Food".
	const at = text.indexOf(" @");
	if (at !== -1) {
		const rest = text.slice(at + 2);
		const byLength = [...projects].sort((a, b) => b.name.length - a.name.length);
		const full = byLength.find((p) => rest.toLowerCase().startsWith(p.name.toLowerCase() + " "));
		if (full) {
			r.project = full;
			text = text.slice(0, at) + " " + rest.slice(full.name.length);
		} else {
			const word = rest.split(" ")[0];
			const matches = projects.filter((p) => p.name.toLowerCase().startsWith(word.toLowerCase()));
			if (matches.length === 1) r.project = matches[0];
			else r.errors.push(matches.length ? `"@${word}" matches several projects — type more of the name` : `No project matches "@${word}"`);
			text = text.slice(0, at) + " " + rest.slice(word.length);
		}
	}

	const words = text.trim().split(/\s+/).filter(Boolean);
	const title: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		const lw = w.toLowerCase();
		let m: RegExpMatchArray | null;

		if ((m = lw.match(/^!(\w+)$/)) && PRIORITY[m[1]]) r.priority = PRIORITY[m[1]];
		else if ((m = w.match(/^#([\p{L}\p{N}_\-/]+)$/u))) r.categories.push(m[1]);
		else if ((m = lw.match(/^~(\d+(?:\.\d+)?)(h|m)?$/))) r.estimate = m[2] === "m" ? round2(Number(m[1]) / 60) : Number(m[1]);
		else if ((m = lw.match(/^\*(\w+)$/)) && REPEAT.includes(m[1])) r.repeat = m[1];
		else if (!time && (time = parseTimeRange(lw))) {
			/* a time like 14:00 or 9am-11am — handled after the loop */
		}
		else if (!r.due && lw === "today") r.due = now.format("YYYY-MM-DD");
		else if (!r.due && (lw === "tomorrow" || lw === "tmr")) r.due = now.clone().add(1, "day").format("YYYY-MM-DD");
		else if (!r.due && /^\d{4}-\d{2}-\d{2}$/.test(lw) && moment(lw, "YYYY-MM-DD", true).isValid()) r.due = lw;
		else if (!r.due && lw === "in" && (m = (words[i + 1] ?? "").toLowerCase().match(/^(\d+)([dwm])$/))) {
			const unit = m[2] === "d" ? "days" : m[2] === "w" ? "weeks" : "months";
			r.due = now.clone().add(Number(m[1]), unit).format("YYYY-MM-DD");
			i++; // also consumed "3d"
		} else if (!r.due && weekday(lw) !== -1) {
			// Next occurrence of that weekday (today counts).
			const target = weekday(lw) + 1; // isoWeekday 1..7
			const d = now.clone();
			while (d.isoWeekday() !== target) d.add(1, "day");
			r.due = d.format("YYYY-MM-DD");
		} else title.push(w);
	}
	if (time) {
		// With a time, the date word means "when I'll do it", not "when it's due".
		const day = r.due ?? now.format("YYYY-MM-DD");
		r.scheduled = `${day}T${time.start}`;
		r.scheduledEnd = time.end && time.end > time.start ? `${day}T${time.end}` : null;
		r.due = null;
	}
	r.title = title.join(" ").trim();
	if (!r.title) r.errors.push("Add a title");
	return r;
}

/**
 * "14:00", "14:00-16:00", "9am", "2:30pm-4pm" → { start: "HH:mm", end: "HH:mm" | null }.
 * A bare number ("4") is never a time, so "chapter 4" stays in the title.
 */
function parseTimeRange(w: string): { start: string; end: string | null } | null {
	const part = "(\\d{1,2})(?::(\\d{2}))?(am|pm)?";
	const m = w.match(new RegExp(`^${part}(?:-${part})?$`));
	if (!m) return null;
	const [, h1, m1, ap1, h2, m2, ap2] = m;
	if (!m1 && !ap1 && !(h2 && ap2)) return null; // needs ":mm" or am/pm ("9-11am" is fine) to count as a time
	const start = to24(h1, m1, ap1 ?? (h2 && !m1 ? ap2 : undefined));
	const end = h2 ? to24(h2, m2, ap2 ?? ap1) : null;
	return start ? { start, end } : null;
}

function to24(h: string, m: string | undefined, ap: string | undefined): string | null {
	let hour = Number(h);
	const min = Number(m ?? 0);
	if (min > 59) return null;
	if (ap) {
		if (hour < 1 || hour > 12) return null;
		if (ap === "pm" && hour !== 12) hour += 12;
		if (ap === "am" && hour === 12) hour = 0;
	} else if (hour > 23) return null;
	return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// "mon", "monday", "tue", "tues"… → 0..6, or -1.
function weekday(w: string): number {
	if (w.length < 3) return -1;
	return WEEKDAYS.findIndex((d) => d.startsWith(w));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
