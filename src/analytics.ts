import { moment } from "obsidian";
import { today } from "./store";
import { isClosed, PRIORITIES, Project, STATUSES, Task, TaskPriority, TaskStatus } from "./types";

// Pure calculations over a list of tasks — no DOM, no charts.

export interface Summary {
	total: number;
	byStatus: Record<TaskStatus, number>;
	open: number; // not done and not failed
	progress: number; // 0..100, share of tasks done
	overdue: number;
	estimate: number; // hours
	spent: number; // hours
	avgDaysToFinish: number | null;
}

export function summarize(tasks: Task[]): Summary {
	const byStatus = countBy(tasks, (t) => t.status, STATUSES);
	const now = today();
	const finishDays = tasks
		.filter((t) => t.status === "done" && t.completed)
		.map((t) => moment(t.completed).diff(moment(createdDate(t)), "days"));

	return {
		total: tasks.length,
		byStatus,
		open: tasks.filter((t) => !isClosed(t.status)).length,
		progress: tasks.length ? Math.round((byStatus.done / tasks.length) * 100) : 0,
		overdue: tasks.filter((t) => isOverdue(t, now)).length,
		estimate: round1(sum(tasks.map((t) => t.estimate ?? 0))),
		spent: round1(sum(tasks.map((t) => t.spent))),
		avgDaysToFinish: finishDays.length ? round1(sum(finishDays) / finishDays.length) : null,
	};
}

export function countByPriority(tasks: Task[]): Record<TaskPriority, number> {
	return countBy(tasks, (t) => t.priority, PRIORITIES);
}

/** Tasks per category, most used first. Tasks without a category count as "none". */
export function countByCategory(tasks: Task[], limit = 8): [string, number][] {
	const counts = new Map<string, number>();
	for (const t of tasks) {
		for (const c of t.category.length ? t.category : ["none"]) counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export interface BurndownPoint {
	label: string; // day "Oct 08" or week "Oct 06" (start of week)
	remaining: number | null; // actual open tasks at the end of this bucket (null after today)
	planned: number; // open tasks if every task had closed on its due date
	completed: number; // tasks done (not failed) during this bucket
}

/**
 * Remaining open tasks over time + how many were finished in each day/week.
 * Ranges longer than ~6 weeks are grouped by week so the chart stays readable.
 */
/**
 * Actual: a task counts from its created date until it's closed (done or failed).
 * Planned: the same tasks, but each one leaves on its due date — tasks without a due date never leave.
 * The range runs to today, or to the latest due date if that's later (only the plan is drawn there).
 */
export function burndown(tasks: Task[]): BurndownPoint[] {
	if (tasks.length === 0) return [];
	const start = chartStart(tasks);
	const now = moment();
	const dues = tasks.filter((t) => t.due).map((t) => moment(t.due));
	const end = dues.length ? moment.max(moment.max(dues), now) : now;
	const unit = end.diff(start, "days") > 42 ? "week" : "day";
	const todayStr = today();
	const fmt = "MMM DD";

	const points: BurndownPoint[] = [];
	for (let cur = start.clone().startOf(unit); !cur.isAfter(end, "day"); cur.add(1, unit)) {
		const bucketEnd = cur.clone().endOf(unit).format("YYYY-MM-DD");
		const bucketStart = cur.format("YYYY-MM-DD");
		const created = tasks.filter((t) => createdDate(t) <= bucketEnd).length;
		const doneByEnd = tasks.filter((t) => t.completed && t.completed <= bucketEnd).length;
		const doneInBucket = tasks.filter(
			(t) => t.status === "done" && t.completed && t.completed >= bucketStart && t.completed <= bucketEnd
		).length;
		const dueByEnd = tasks.filter((t) => createdDate(t) <= bucketEnd && t.due && t.due <= bucketEnd).length;
		const isFuture = bucketStart > todayStr;
		points.push({
			label: cur.format(fmt),
			remaining: isFuture ? null : created - doneByEnd,
			planned: created - dueByEnd,
			completed: isFuture ? 0 : doneInBucket,
		});
	}
	return points;
}

/** Which date places a task on the "status over time" chart. */
export type TrendDate = "created" | "due" | "completed";

export interface StatusTrend {
	unit: "day" | "week" | "month";
	labels: string[];
	series: Record<TaskStatus, number[]>;
	skipped: number; // tasks without the chosen date
}

/**
 * Tasks per day/week/month, split by their *current* status (like a Notion chart: one line per status).
 * `by` picks which date places a task: created (default), due, or completed (closed).
 * The bucket size grows with the date range.
 */
export function statusOverTime(tasks: Task[], by: TrendDate = "created"): StatusTrend {
	const series = Object.fromEntries(STATUSES.map((s) => [s, [] as number[]])) as Record<TaskStatus, number[]>;
	// Tasks that don't have the chosen date (e.g. no due date) can't be placed on the chart.
	const dated = tasks
		.map((t) => ({ t, date: trendDate(t, by) }))
		.filter((x): x is { t: Task; date: string } => x.date !== null);
	const skipped = tasks.length - dated.length;
	if (dated.length === 0) return { unit: "day", labels: [], series, skipped };

	const dates = dated.map((x) => moment(x.date));
	// At least the last 7 days; due dates can also reach into the future.
	const start = moment.min(moment.min(dates), moment().startOf("day").subtract(MIN_DAYS_SHOWN - 1, "days"));
	const end = moment.max(moment.max(dates), moment());
	const days = end.diff(start, "days");
	// Aim for ~4–12 points: daily counts on a few tasks are just 0/1 spikes.
	const unit = days > 84 ? "month" : days > 10 ? "week" : "day";
	const fmt = unit === "month" ? "MMM YYYY" : "MMM DD";

	const labels: string[] = [];
	for (let cur = start.clone().startOf(unit); !cur.isAfter(end, "day"); cur.add(1, unit)) {
		const from = cur.format("YYYY-MM-DD");
		const to = cur.clone().endOf(unit).format("YYYY-MM-DD");
		const inBucket = dated.filter((x) => x.date >= from && x.date <= to);
		labels.push(cur.format(fmt));
		for (const s of STATUSES) series[s].push(inBucket.filter((x) => x.t.status === s).length);
	}
	return { unit, labels, series, skipped };
}

function trendDate(t: Task, by: TrendDate): string | null {
	if (by === "due") return t.due;
	if (by === "completed") return t.completed;
	return createdDate(t);
}

/** Tasks that have an estimate or tracked time, largest first. */
export function estimateVsSpent(tasks: Task[], limit = 10): Task[] {
	return tasks
		.filter((t) => (t.estimate ?? 0) > 0 || t.spent > 0)
		.sort((a, b) => Math.max(b.estimate ?? 0, b.spent) - Math.max(a.estimate ?? 0, a.spent))
		.slice(0, limit);
}

export function overdueTasks(tasks: Task[]): Task[] {
	const now = today();
	return tasks.filter((t) => isOverdue(t, now)).sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
}

/** Open tasks due today or within the next `days` days. */
export function upcomingTasks(tasks: Task[], days = 7): Task[] {
	const now = today();
	const until = moment().add(days, "days").format("YYYY-MM-DD");
	return tasks
		.filter((t) => !isClosed(t.status) && t.due !== null && t.due >= now && t.due <= until)
		.sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
}

export interface ProjectRow {
	project: Project;
	summary: Summary;
}

/** One summary per project that has at least one task. */
export function projectRows(projects: Project[], tasks: Task[]): ProjectRow[] {
	return projects
		.map((project) => ({
			project,
			summary: summarize(tasks.filter((t) => t.project?.id === project.id)),
		}))
		.filter((r) => r.summary.total > 0);
}

export function isOverdue(task: Task, now: string): boolean {
	return !isClosed(task.status) && task.due !== null && task.due < now;
}

// ---------- helpers ----------

// Time charts always cover at least the last 7 days, so a new project still shows a readable line.
const MIN_DAYS_SHOWN = 7;

function chartStart(tasks: Task[]): moment.Moment {
	const earliest = moment.min(tasks.map((t) => moment(createdDate(t))));
	return moment.min(earliest, moment().startOf("day").subtract(MIN_DAYS_SHOWN - 1, "days"));
}

// Older/hand-made task notes may lack `created`; fall back to the file's creation time.
function createdDate(t: Task): string {
	return t.created ?? moment(t.file.stat.ctime).format("YYYY-MM-DD");
}

function countBy<K extends string>(tasks: Task[], key: (t: Task) => K, keys: readonly K[]): Record<K, number> {
	const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
	for (const t of tasks) out[key(t)]++;
	return out;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------- period filter (dashboard) ----------

export type Period = "day" | "week" | "month" | "year" | "all";

export const PERIOD_LABELS: [Period, string][] = [
	["day", "Today"],
	["week", "Week"],
	["month", "Month"],
	["year", "Year"],
	["all", "All"],
];

/** First and last day (YYYY-MM-DD) of the current day/week/month/year; null for "all". */
export function periodRange(period: Period): { from: string; to: string } | null {
	if (period === "all") return null;
	const unit = period === "day" ? "day" : period;
	return {
		from: moment().startOf(unit).format("YYYY-MM-DD"),
		to: moment().endOf(unit).format("YYYY-MM-DD"),
	};
}

/**
 * Tasks due inside the period, plus open overdue tasks from before it (they still need doing).
 * "all" returns every task, including ones without a due date.
 */
export function tasksInPeriod(tasks: Task[], period: Period): Task[] {
	const range = periodRange(period);
	if (!range) return tasks;
	const now = today();
	return tasks.filter(
		(t) => t.due !== null && ((t.due >= range.from && t.due <= range.to) || isOverdue(t, now))
	);
}
