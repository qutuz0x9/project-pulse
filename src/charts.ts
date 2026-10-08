import {
	BarController,
	BarElement,
	CategoryScale,
	Chart,
	ChartDataset,
	Legend,
	LinearScale,
	LineController,
	LineElement,
	PointElement,
	Tooltip,
} from "chart.js";
import type { BurndownPoint, StatusTrend } from "./analytics";
import { STATUSES, STATUS_LABELS, Task, TaskPriority, TaskStatus } from "./types";

// Register only what we use so the bundle stays small (Chart.js "tree-shaking").
Chart.register(
	BarController,
	BarElement,
	CategoryScale,
	Legend,
	LinearScale,
	LineController,
	LineElement,
	PointElement,
	Tooltip
);

// Checked for color-blind separation & contrast in light and dark mode.
// Done is teal-green (not pure green) so it stays distinct from Failed red for red-green color-blind readers.
export const STATUS_COLORS: Record<TaskStatus, string> = {
	todo: "#9ca3af", // neutral: not started (also drawn dashed in line charts)
	"in-progress": "#9b5de5", // vault purple
	done: "#0d9488",
	failed: "#e5484d",
};
export const PRIORITY_COLORS: Record<TaskPriority, string> = {
	high: "#dc2626",
	medium: "#c08306",
	low: "#2563eb",
};
// Single-series charts use a hue no status/priority uses, so it never reads as one of them.
export const CATEGORY_COLOR = "#64748b"; // neutral slate
const ESTIMATE_COLOR = "rgba(155, 93, 229, 0.38)"; // wide light bar = the plan
const SPENT_COLOR = "#9b5de5"; // solid = what happened
const OVER_COLOR = "#dc2626"; // spent more than estimated

/** Reads Obsidian's current theme colors so charts match light/dark mode. */
function theme() {
	const css = getComputedStyle(document.body);
	const v = (name: string) => css.getPropertyValue(name).trim();
	return {
		text: v("--text-muted"),
		grid: v("--background-modifier-border"),
		surface: v("--background-secondary") || v("--background-primary"),
		font: v("--font-interface"),
	};
}

function baseOptions(animate: boolean) {
	const t = theme();
	Chart.defaults.color = t.text;
	if (t.font) Chart.defaults.font.family = t.font;
	Chart.defaults.font.size = 11;
	return {
		t,
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: animate ? { duration: 400 } : (false as const),
			plugins: {
				legend: {
					position: "top" as const,
					align: "end" as const,
					labels: { usePointStyle: true, pointStyle: "circle" as const, boxWidth: 7, boxHeight: 7, padding: 14 },
				},
				tooltip: { padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true },
			},
		},
	};
}

/** Value axis: light grid, whole numbers. Category axis: no grid. */
function axes(grid: string, horizontal: boolean, stacked: boolean) {
	const value = {
		stacked,
		beginAtZero: true,
		grace: "10%", // headroom so the highest point/line isn't cut off at the top
		grid: { color: grid, drawTicks: false },
		border: { display: false },
		ticks: { padding: 8, precision: 0, maxTicksLimit: 6 },
	};
	const category = {
		stacked,
		grid: { display: false },
		border: { display: false },
		// Flat labels. Date axes may skip some when crowded; a horizontal chart's names must all show.
		ticks: horizontal ? { padding: 8, autoSkip: false } : { padding: 8, maxRotation: 0, autoSkipPadding: 12 },
	};
	return horizontal ? { x: value, y: category } : { x: category, y: value };
}

export function barChart(
	canvas: HTMLCanvasElement,
	labels: string[],
	datasets: ChartDataset<"bar">[],
	animate: boolean,
	opts: { horizontal?: boolean; stacked?: boolean; unit?: string } = {}
): Chart {
	const { t, options } = baseOptions(animate);
	const horizontal = !!opts.horizontal;
	return new Chart(canvas, {
		type: "bar",
		data: {
			labels,
			datasets: datasets.map((d) => ({
				borderRadius: opts.stacked ? 3 : 4,
				borderSkipped: opts.stacked ? false : "start",
				maxBarThickness: horizontal ? 16 : 24,
				categoryPercentage: 0.7,
				// 2px surface-colored gap between stacked segments.
				borderColor: t.surface,
				borderWidth: opts.stacked ? (horizontal ? { right: 2 } : { top: 2 }) : 0,
				...d,
			})),
		},
		options: {
			...options,
			indexAxis: horizontal ? "y" : "x",
			scales: axes(t.grid, horizontal, !!opts.stacked),
			plugins: {
				...options.plugins,
				// A single series is named by the card title — no legend box needed.
				legend: { ...options.plugins.legend, display: datasets.length > 1 },
				tooltip: {
					...options.plugins.tooltip,
					callbacks: opts.unit
						? { label: (ctx) => ` ${ctx.dataset.label ?? ""}: ${ctx.formattedValue}${opts.unit}` }
						: {},
				},
			},
		},
	});
}

/**
 * "Bullet" bars: a wide light bar for the estimate with a thin solid bar for time spent drawn on top of it.
 * The spent bar turns red when it went over the estimate.
 */
export function estimateChart(canvas: HTMLCanvasElement, tasks: Task[], animate: boolean): Chart {
	const over = (t: Task) => t.estimate !== null && t.estimate > 0 && t.spent > t.estimate;
	return barChart(
		canvas,
		tasks.map((t) => truncate(t.title, 26)),
		[
			// Spent first so it's drawn on top of the estimate.
			{
				label: "Spent",
				data: tasks.map((t) => t.spent),
				backgroundColor: tasks.map((t) => (over(t) ? OVER_COLOR : SPENT_COLOR)),
				grouped: false,
				barThickness: 6,
				order: 0,
			},
			{
				label: "Estimate",
				data: tasks.map((t) => t.estimate ?? 0),
				backgroundColor: ESTIMATE_COLOR,
				grouped: false,
				barThickness: 16,
				order: 1,
			},
		],
		animate,
		{ horizontal: true, unit: "h" }
	);
}

/**
 * Solid line = open tasks actually left; dashed line = planned (by due dates);
 * bars = tasks completed in that day/week. All the same unit (tasks), one axis.
 */
export function burndownChart(canvas: HTMLCanvasElement, points: BurndownPoint[], animate: boolean): Chart {
	const { t, options } = baseOptions(animate);
	return new Chart(canvas, {
		data: {
			labels: points.map((p) => p.label),
			datasets: [
				{
					type: "line",
					label: "Actual",
					data: points.map((p) => p.remaining),
					borderColor: SPENT_COLOR,
					backgroundColor: SPENT_COLOR,
					borderWidth: 2,
					pointRadius: 0,
					pointHoverRadius: 5,
					pointHoverBorderWidth: 2,
					pointHoverBorderColor: t.surface,
					tension: 0, // straight segments: daily counts, no invented in-between values
				},
				{
					type: "line",
					label: "Planned",
					data: points.map((p) => p.planned),
					borderColor: STATUS_COLORS.todo,
					backgroundColor: STATUS_COLORS.todo,
					borderWidth: 2,
					borderDash: [5, 4], // dashed = the plan, solid = what happened
					pointRadius: 0,
					pointHoverRadius: 5,
					pointHoverBorderWidth: 2,
					pointHoverBorderColor: t.surface,
					tension: 0,
				},
				{
					type: "bar",
					label: "Completed",
					data: points.map((p) => p.completed),
					backgroundColor: STATUS_COLORS.done,
					borderRadius: 3,
					borderSkipped: "start",
					maxBarThickness: 12,
				},
			],
		},
		options: {
			...options,
			// Hovering anywhere in a column shows that day's values (crosshair-style).
			interaction: { mode: "index", intersect: false },
			scales: {
				...axes(t.grid, false, false),
				x: { ...axes(t.grid, false, false).x, ticks: { padding: 8, maxRotation: 0, autoSkipPadding: 16 } },
			},
		},
	});
}

/** One line per status. Statuses with no tasks at all are left out to keep the legend short. */
export function statusTrendChart(canvas: HTMLCanvasElement, trend: StatusTrend, animate: boolean): Chart {
	const { t, options } = baseOptions(animate);
	const few = trend.labels.length <= 12;
	const used = STATUSES.filter((s) => trend.series[s].some((n) => n > 0));
	return new Chart(canvas, {
		type: "line",
		data: {
			labels: trend.labels,
			datasets: used.map((s) => ({
				label: STATUS_LABELS[s],
				data: trend.series[s],
				borderColor: STATUS_COLORS[s],
				backgroundColor: STATUS_COLORS[s],
				borderWidth: 2,
				borderDash: s === "todo" ? [5, 4] : undefined, // second cue besides color
				pointRadius: few ? 3 : 0,
				pointHoverRadius: 5,
				pointBorderColor: t.surface,
				pointBorderWidth: 2,
				tension: 0, // whole-number counts per period — straight segments, not curves
			})),
		},
		options: {
			...options,
			interaction: { mode: "index", intersect: false },
			scales: {
				...axes(t.grid, false, false),
				x: { ...axes(t.grid, false, false).x, ticks: { padding: 8, maxRotation: 0, autoSkipPadding: 16 } },
			},
		},
	});
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
