import { moment } from "obsidian";
import type { PomodoroSession } from "./settings";
import { today } from "./store";

// Pure calculations over the Pomodoro session history — no DOM, no charts.

export interface PeriodStats {
	pomodoros: number; // completed sessions
	minutes: number; // focus minutes, completed + stopped early
	avgMinutes: number; // average session length
	completion: number; // 0..100, share of sessions finished instead of stopped
}

const day = (s: PomodoroSession) => s.start.slice(0, 10);

export function periodStats(sessions: PomodoroSession[]): PeriodStats {
	const minutes = sessions.reduce((a, s) => a + s.minutes, 0);
	const pomodoros = sessions.filter((s) => s.completed).length;
	return {
		pomodoros,
		minutes,
		avgMinutes: sessions.length ? Math.round(minutes / sessions.length) : 0,
		completion: sessions.length ? Math.round((pomodoros / sessions.length) * 100) : 0,
	};
}

export function onDay(sessions: PomodoroSession[], date: string): PomodoroSession[] {
	return sessions.filter((s) => day(s) === date);
}

/** Sessions since the start of this week (locale week start). */
export function thisWeek(sessions: PomodoroSession[]): PomodoroSession[] {
	const from = moment().startOf("week").format("YYYY-MM-DD");
	return sessions.filter((s) => day(s) >= from);
}

/** Days in a row, ending today (or yesterday if nothing yet today), with at least one 🍅. */
export function streak(sessions: PomodoroSession[]): number {
	const days = new Set(sessions.filter((s) => s.completed).map(day));
	const cur = moment();
	if (!days.has(today())) cur.subtract(1, "day");
	let n = 0;
	while (days.has(cur.format("YYYY-MM-DD"))) {
		n++;
		cur.subtract(1, "day");
	}
	return n;
}

/** Focus minutes for each of the last `n` days, oldest first. */
export function dailyMinutes(sessions: PomodoroSession[], n = 14): { label: string; minutes: number }[] {
	const out: { label: string; minutes: number }[] = [];
	for (let i = n - 1; i >= 0; i--) {
		const d = moment().subtract(i, "days");
		const key = d.format("YYYY-MM-DD");
		out.push({ label: d.format("MMM DD"), minutes: onDay(sessions, key).reduce((a, s) => a + s.minutes, 0) });
	}
	return out;
}

/** Tasks with the most focus time, largest first. Grouped by title so renames don't split a task. */
export function focusByTask(sessions: PomodoroSession[], limit = 6): { title: string; task: string; minutes: number }[] {
	const map = new Map<string, { title: string; task: string; minutes: number }>();
	for (const s of sessions) {
		const row = map.get(s.title) ?? { title: s.title, task: s.task, minutes: 0 };
		row.minutes += s.minutes;
		row.task = s.task; // latest known path
		map.set(s.title, row);
	}
	return [...map.values()].sort((a, b) => b.minutes - a.minutes).slice(0, limit);
}

/** 135 → "2h 15m", 40 → "40m". */
export function formatMinutes(m: number): string {
	return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
