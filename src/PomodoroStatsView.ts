import type { Chart } from "chart.js";
import { periodRange, type Period } from "./analytics";
import { ItemView, moment, setIcon, WorkspaceLeaf } from "obsidian";
import { barChart, lineChart } from "./charts";
import type ProjectPulsePlugin from "./main";
import {
	allTimeStats,
	between,
	focusBuckets,
	formatMinutes,
	onDay,
	periodStats,
	PeriodStats,
	streak,
} from "./pomodoroStats";
import { today } from "./store";

export const VIEW_TYPE_POMODORO_STATS = "project-pulse-pomodoro-stats";

const PURPLE = "#9b5de5";
const ACCENT = { purple: "155, 93, 229", gold: "192, 131, 6", green: "13, 148, 136", blue: "37, 99, 235" };
const RECENT_LIMIT = 20;
const PERIODS: [Period, string][] = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["all", "All"]];

/** Main-area tab: overview tiles → period table → focus over time → focus per day → recent sessions. */
export class PomodoroStatsView extends ItemView {
	private charts: Chart[] = [];
	private hasRendered = false;
	private period: Period = "week";
	private listPeriod: Period = "week";

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
		const brand = header.createDiv({ cls: "tt-brand" });
		setIcon(brand.createDiv({ cls: "tt-brand-icon" }), "timer");
		const heading = brand.createDiv({ cls: "tt-dash-heading" });
		heading.createDiv({ cls: "tt-dash-eyebrow", text: "Pomodoro" });
		heading.createEl("h2", { cls: "tt-dash-title", text: "Statistics" });
		const recorded = sessions.length + this.plugin.settings.pomodoroArchive.sessions;
		const chips = heading.createDiv({ cls: "tt-pstats-chips" });
		chips.createSpan({ cls: "tt-pstats-chip", text: `${recorded} focus session${recorded === 1 ? "" : "s"}` });
		if (sessions.length) chips.createSpan({ cls: "tt-pstats-chip", text: `since ${moment(sessions[sessions.length - 1].start).format("MMM D, YYYY")}` });
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

		// Periods table: each current period is followed by the one before it, with the change in focus time
		section(root, "By period");
		const table = root.createDiv({ cls: "tt-ptable tt-period-table" });
		const head = table.createDiv({ cls: "tt-prow tt-prow-head" });
		for (const h of ["Period", "Pomodoros", "Focus", "Avg length", "Completion", "vs previous"]) head.createSpan({ text: h });
		const row = (label: string, p: PeriodStats, prev?: PeriodStats) => {
			const r = table.createDiv({ cls: `tt-prow${prev ? "" : " is-muted"}` });
			r.createSpan({ cls: "tt-prow-name", text: label });
			r.createSpan({ cls: "tt-num tt-big", text: `${p.pomodoros}` });
			r.createSpan({ cls: "tt-num", text: formatMinutes(p.minutes) });
			r.createSpan({ cls: "tt-num", text: p.avgMinutes ? `${p.avgMinutes}m` : "—" });
			r.createSpan({ cls: "tt-num", text: p.minutes ? `${p.completion}%` : "—" });
			const diff = prev ? p.minutes - prev.minutes : 0;
			const pct = prev && prev.minutes ? ` (${diff > 0 ? "+" : ""}${Math.round((diff / prev.minutes) * 100)}%)` : "";
			r.createSpan({
				cls: `tt-num tt-delta ${diff > 0 ? "is-up" : diff < 0 ? "is-down" : ""}`.trim(),
				text: prev ? (diff === 0 ? "same" : `${diff > 0 ? "+" : "−"}${formatMinutes(Math.abs(diff))}${pct}`) : "",
			});
		};
		const stats = (unit: "day" | "week" | "month", ago: number) => {
			const m = moment().subtract(ago, unit === "day" ? "day" : unit === "week" ? "week" : "month");
			return periodStats(between(sessions, m.clone().startOf(unit).format("YYYY-MM-DD"), m.clone().endOf(unit).format("YYYY-MM-DD")));
		};
		for (const [unit, now, before] of [["day", "Today", "Yesterday"], ["week", "This week", "Last week"], ["month", "This month", "Last month"]] as const) {
			row(now, stats(unit, 0), stats(unit, 1));
			row(before, stats(unit, 1));
		}
		row("All time", all);

		// Charts
		section(root, "Focus");
		this.periodSwitch(root, this.period, (p) => (this.period = p));
		const buckets = focusBuckets(sessions, this.period);
		const labels = buckets.map((b) => b.label);
		const minutes = buckets.map((b) => b.minutes);
		const unit = this.period === "day" ? "Minutes per hour, today" : this.period === "year" || this.period === "all" ? "Minutes per month" : "Minutes per day";
		const rows = root.createDiv({ cls: "tt-pstats-rows" });
		this.chartCard(rows, "Focus over time", unit, (c) => lineChart(c, labels, minutes, PURPLE, "Focus", animate, "m"));
		this.chartCard(rows, "Focus per day", unit, (c) =>
			barChart(c, labels, [{ label: "Focus", data: minutes, backgroundColor: PURPLE }], animate, { unit: "m" })
		);

		// Recent sessions
		section(root, "Recent sessions");
		this.periodSwitch(root, this.listPeriod, (p) => (this.listPeriod = p));
		const range = periodRange(this.listPeriod);
		const shown = range ? sessions.filter((s) => s.start.slice(0, 10) >= range.from && s.start.slice(0, 10) <= range.to) : sessions;
		const list = root.createDiv({ cls: "tt-sessions" });
		for (const s of shown.slice(0, RECENT_LIMIT)) {
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
		if (shown.length === 0) list.createDiv({ cls: "tt-list-more", text: "No sessions in this period" });
		if (shown.length > RECENT_LIMIT) {
			list.createDiv({ cls: "tt-list-more", text: `Showing the latest ${RECENT_LIMIT} of ${shown.length}` });
		}
	}

	private periodSwitch(parent: HTMLElement, current: Period, set: (p: Period) => void): void {
		const seg = parent.createDiv({ cls: "tt-seg", attr: { role: "group", "aria-label": "Period" } });
		for (const [value, label] of PERIODS) {
			const btn = seg.createEl("button", { cls: `tt-seg-btn${current === value ? " is-active" : ""}`, text: label });
			btn.addEventListener("click", () => {
				if (current === value) return;
				set(value);
				// render() rebuilds the page, which would jump back to the top — put the scroll position back.
				const top = this.contentEl.scrollTop;
				this.render();
				this.contentEl.scrollTop = top;
			});
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
