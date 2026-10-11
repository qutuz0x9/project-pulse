import { moment } from "obsidian";
import type { PomodoroArchive, PomodoroSession } from "./settings";
import type { Period } from "./analytics";
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

/** All-time stats: the detailed history plus the totals of older, archived sessions. */
export function allTimeStats(sessions: PomodoroSession[], archive: PomodoroArchive): PeriodStats {
	const count = sessions.length + archive.sessions;
	const minutes = sessions.reduce((a, s) => a + s.minutes, 0) + archive.minutes;
	const pomodoros = sessions.filter((s) => s.completed).length + archive.pomodoros;
	return {
		pomodoros,
		minutes,
		avgMinutes: count ? Math.round(minutes / count) : 0,
		completion: count ? Math.round((pomodoros / count) * 100) : 0,
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

/** Sessions that started between two dates (inclusive, YYYY-MM-DD). */
export function between(sessions: PomodoroSession[], from: string, to: string): PomodoroSession[] {
	return sessions.filter((s) => day(s) >= from && day(s) <= to);
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

/** Focus minutes per bucket for a period: Day → hours, Week/Month → days, Year/All → months. */
export function focusBuckets(sessions: PomodoroSession[], period: Period): { label: string; minutes: number }[] {
	const sum = (list: PomodoroSession[]) => list.reduce((a, s) => a + s.minutes, 0);
	if (period === "day") {
		const d = today();
		const mine = onDay(sessions, d);
		return Array.from({ length: 24 }, (_, h) => ({
			label: `${String(h).padStart(2, "0")}:00`,
			minutes: sum(mine.filter((s) => moment(s.start).hour() === h)),
		}));
	}
	if (period === "week" || period === "month") {
		const from = moment().startOf(period);
		const n = period === "week" ? 7 : from.daysInMonth();
		return Array.from({ length: n }, (_, i) => {
			const d = from.clone().add(i, "days");
			return { label: d.format(period === "week" ? "ddd D" : "D"), minutes: sum(onDay(sessions, d.format("YYYY-MM-DD"))) };
		});
	}
	const first = period === "year" ? moment().startOf("year") : moment(sessions.reduce((m, s) => (s.start < m ? s.start : m), sessions[0]?.start ?? new Date().toISOString())).startOf("month");
	const last = moment().startOf("month");
	const out: { label: string; minutes: number }[] = [];
	for (const m = first.clone(); m.isSameOrBefore(last); m.add(1, "month")) {
		const key = m.format("YYYY-MM");
		out.push({ label: m.format(period === "year" ? "MMM" : "MMM YY"), minutes: sum(sessions.filter((s) => s.start.slice(0, 7) === key)) });
	}
	return out;
}

/** 135 → "2h 15m", 40 → "40m". */
export function formatMinutes(m: number): string {
	return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
