import type { Chart } from "chart.js";
import { ItemView, moment, setIcon, WorkspaceLeaf } from "obsidian";
import { barChart } from "./charts";
import type ProjectPulsePlugin from "./main";
import {
	allTimeStats,
	dailyMinutes,
	focusByTask,
	formatMinutes,
	onDay,
	periodStats,
	PeriodStats,
	streak,
	thisWeek,
} from "./pomodoroStats";
import { today } from "./store";

export const VIEW_TYPE_POMODORO_STATS = "project-pulse-pomodoro-stats";

const PURPLE = "#9b5de5";
const ACCENT = { purple: "155, 93, 229", gold: "192, 131, 6", green: "13, 148, 136", blue: "37, 99, 235" };
const RECENT_LIMIT = 20;

/** Main-area tab: overview tiles → period table → focus per day → focus by task → recent sessions. */
export class PomodoroStatsView extends ItemView {
	private charts: Chart[] = [];
	private hasRendered = false;

	constructor(leaf: WorkspaceLeaf, private plugin: ProjectPulsePlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_POMODORO_STATS;
	}

	getDisplayText(): string {
		return "Pomodoro statistics";
	}

	getIcon(): string {
		return "trending-up";
	}

	async onOpen(): Promise<void> {
		this.registerEvent(this.plugin.pomodoro.on("changed", () => this.render()));
		this.registerEvent(this.app.workspace.on("css-change", () => this.render()));
		this.render();
	}

	async onClose(): Promise<void> {
		this.destroyCharts();
		this.contentEl.empty();
	}

	private destroyCharts(): void {
		this.charts.forEach((c) => c.destroy());
		this.charts = [];
	}

	private render(): void {
		this.destroyCharts();
		const root = this.contentEl;
		root.empty();
		root.addClass("tt-view", "tt-dash", "tt-pstats");

		const sessions = [...this.plugin.settings.pomodoroSessions].sort((a, b) => b.start.localeCompare(a.start));
		const animate = !this.hasRendered;
		this.hasRendered = true;

		// Header
		const header = root.createDiv({ cls: "tt-dash-header" });
		const heading = header.createDiv({ cls: "tt-dash-heading" });
		heading.createDiv({ cls: "tt-dash-eyebrow", text: "Pomodoro" });
		heading.createEl("h2", { cls: "tt-dash-title", text: "Statistics" });
		const recorded = sessions.length + this.plugin.settings.pomodoroArchive.sessions;
		heading.createDiv({ cls: "tt-dash-sub", text: `${recorded} focus session${recorded === 1 ? "" : "s"} recorded` });
		const controls = header.createDiv({ cls: "tt-dash-controls" });
		const openPanel = controls.createEl("button", { cls: "mod-cta", text: "Open Pomodoro" });
		openPanel.addEventListener("click", () => this.plugin.activatePomodoroView());

		if (sessions.length === 0) {
			root.createDiv({
				cls: "tt-empty",
				text: "No focus sessions yet. Start one from the Pomodoro panel — every session is recorded here.",
			});
			return;
		}

		// Overview: today vs yesterday, streak, total
		const todayStats = periodStats(onDay(sessions, today()));
		const yesterdayStats = periodStats(onDay(sessions, moment().subtract(1, "day").format("YYYY-MM-DD")));
		const all = allTimeStats(sessions, this.plugin.settings.pomodoroArchive);
		const tiles = root.createDiv({ cls: "tt-kpis" });
		tile(tiles, "Today's pomodoros", `${todayStats.pomodoros}`, compare(todayStats.pomodoros - yesterdayStats.pomodoros, (n) => `${n}`), ACCENT.purple);
		tile(tiles, "Today's focus", formatMinutes(todayStats.minutes), compare(todayStats.minutes - yesterdayStats.minutes, formatMinutes), ACCENT.blue);
		const days = streak(sessions);
		tile(tiles, "Day streak", `${days}`, { text: days ? "days in a row with a 🍅" : "finish a 🍅 today to start one", tone: "" }, ACCENT.gold);
		tile(tiles, "Total focus", formatMinutes(all.minutes), { text: `${all.pomodoros} pomodoros in all`, tone: "" }, ACCENT.green);

		// Periods table
		section(root, "By period");
		const table = root.createDiv({ cls: "tt-ptable tt-period-table" });
		const head = table.createDiv({ cls: "tt-prow tt-prow-head" });
		for (const h of ["Period", "Pomodoros", "Focus", "Avg length", "Completion"]) head.createSpan({ text: h });
		const row = (label: string, p: PeriodStats) => {
			const r = table.createDiv({ cls: "tt-prow" });
			r.createSpan({ cls: "tt-prow-name", text: label });
			r.createSpan({ cls: "tt-num tt-big", text: `${p.pomodoros}` });
			r.createSpan({ cls: "tt-num", text: formatMinutes(p.minutes) });
			r.createSpan({ cls: "tt-num", text: p.avgMinutes ? `${p.avgMinutes}m` : "—" });
			r.createSpan({ cls: "tt-num", text: p.minutes ? `${p.completion}%` : "—" });
		};
		row("Today", todayStats);
		row("This week", periodStats(thisWeek(sessions)));
		row("All time", all);

		// Charts
		section(root, "Focus");
		const grid = root.createDiv({ cls: "tt-grid" });
		const daily = dailyMinutes(sessions, 14);
		this.chartCard(grid, "Focus per day", "Minutes, last 14 days", (c) =>
			barChart(c, daily.map((d) => d.label), [{ label: "Focus", data: daily.map((d) => d.minutes), backgroundColor: PURPLE }], animate, { unit: "m" })
		);
		const byTask = focusByTask(sessions);
		this.chartCard(grid, "Focus by task", "Top tasks by focus time", (c) =>
			barChart(
				c,
				byTask.map((t) => (t.title.length > 26 ? t.title.slice(0, 25) + "…" : t.title)),
				[{ label: "Focus", data: byTask.map((t) => t.minutes), backgroundColor: PURPLE }],
				animate,
				{ horizontal: true, unit: "m" }
			)
		);

		// Recent sessions
		section(root, "Recent sessions");
		const list = root.createDiv({ cls: "tt-sessions" });
		for (const s of sessions.slice(0, RECENT_LIMIT)) {
			const item = list.createDiv({ cls: "tt-session" });
			item.createSpan({ cls: "tt-session-time", text: moment(s.start).format("MMM D, HH:mm") });
			item.createSpan({ cls: "tt-session-min", text: `${s.minutes} min` });
			item.createSpan({
				cls: `tt-badge ${s.completed ? "is-completed" : "is-stopped"}`,
				text: s.completed ? "Completed" : "Stopped",
			});
			const title = item.createEl("a", { cls: "tt-session-task", text: s.title });
			title.addEventListener("click", () => {
				const file = this.app.vault.getFileByPath(s.task);
				if (file) this.app.workspace.getLeaf(false).openFile(file);
			});
			const del = item.createEl("button", {
				cls: "clickable-icon tt-delete-btn",
				attr: { "aria-label": "Remove from statistics (the task keeps its logged time)" },
			});
			setIcon(del, "trash-2");
			del.addEventListener("click", () => this.plugin.pomodoro.deleteSession(s.id));
		}
		if (sessions.length > RECENT_LIMIT) {
			list.createDiv({ cls: "tt-list-more", text: `Showing the latest ${RECENT_LIMIT} of ${sessions.length}` });
		}
	}

	private chartCard(parent: HTMLElement, title: string, sub: string, build: (canvas: HTMLCanvasElement) => Chart): void {
		const card = parent.createDiv({ cls: "tt-card" });
		const head = card.createDiv({ cls: "tt-card-head" });
		head.createDiv({ cls: "tt-card-title", text: title });
		head.createDiv({ cls: "tt-card-sub", text: sub });
		const canvas = card.createDiv({ cls: "tt-chart" }).createEl("canvas");
		this.charts.push(build(canvas));
	}
}

function section(parent: HTMLElement, label: string): void {
	parent.createDiv({ cls: "tt-section", text: label });
}

/** "2 more than yesterday" / "15m less than yesterday" / "same as yesterday". */
function compare(diff: number, fmt: (n: number) => string): { text: string; tone: string } {
	if (diff === 0) return { text: "same as yesterday", tone: "" };
	return diff > 0
		? { text: `${fmt(diff)} more than yesterday`, tone: "is-up" }
		: { text: `${fmt(-diff)} less than yesterday`, tone: "is-down" };
}

function tile(parent: HTMLElement, label: string, value: string, sub: { text: string; tone: string }, accent: string): void {
	const t = parent.createDiv({ cls: "tt-kpi" });
	t.setCssProps({ "--c": accent });
	t.createDiv({ cls: "tt-kpi-label", text: label });
	t.createDiv({ cls: "tt-kpi-value", text: value });
	t.createDiv({ cls: `tt-kpi-sub ${sub.tone}`.trim(), text: sub.text });
}
