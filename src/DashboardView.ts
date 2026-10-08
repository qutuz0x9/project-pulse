import type { Chart } from "chart.js";
import { ItemView, moment, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import {
	burndown,
	countByCategory,
	estimateVsSpent,
	overdueTasks,
	projectRows,
	statusOverTime,
	TrendDate,
	summarize,
	Summary,
	upcomingTasks,
} from "./analytics";
import { barChart, burndownChart, CATEGORY_COLOR, estimateChart, STATUS_COLORS, statusTrendChart } from "./charts";
import type TaskTrackerPlugin from "./main";
import { today } from "./store";
import { isClosed, PRIORITIES, PRIORITY_LABELS, Project, STATUSES, STATUS_LABELS, Task, TaskStatus } from "./types";

// Order of segments in stacked status bars: finished work first, then active, then waiting.
const STACK_ORDER: TaskStatus[] = ["done", "failed", "in-progress", "todo"];

export const VIEW_TYPE_DASHBOARD = "task-tracker-dashboard";

// KPI accents as "r, g, b" (vault style: purple-led, each tile its own accent).
const ACCENT = {
	purple: "155, 93, 229",
	green: "13, 148, 136",
	red: "220, 38, 38",
	gold: "192, 131, 6",
	blue: "37, 99, 235",
};

/**
 * Layout, top to bottom — most actionable first:
 * header → KPI tiles → needs attention → projects (all-projects mode) → progress over time → breakdown → time.
 */
export class DashboardView extends ItemView {
	private projectScope = "all"; // "all" or a project id
	private charts: Chart[] = [];
	private hasRendered = false;
	private trendBy: TrendDate = "created"; // switch on the "status over time" chart
	private trendChart: Chart | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: TaskTrackerPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_DASHBOARD;
	}

	getDisplayText(): string {
		return "Task Dashboard";
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	async onOpen(): Promise<void> {
		this.registerEvent(this.plugin.store.on("changed", () => this.render()));
		// Charts read theme colors when drawn, so redraw on light/dark switch.
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
		this.trendChart?.destroy();
		this.trendChart = null;
	}

	/** "Tasks by status over time" with a Created / Due / Completed switch that redraws only this card. */
	private renderTrendCard(parent: HTMLElement, tasks: Task[], animate: boolean): void {
		const card = parent.createDiv({ cls: "tt-card" });
		const head = card.createDiv({ cls: "tt-card-head tt-card-head-row" });
		const titles = head.createDiv();
		titles.createDiv({ cls: "tt-card-title", text: "Tasks by status over time" });
		const sub = titles.createDiv({ cls: "tt-card-sub" });

		const seg = head.createDiv({ cls: "tt-seg", attr: { role: "group", "aria-label": "Place tasks by" } });
		const body = card.createDiv();
		const options: [TrendDate, string][] = [["created", "Created"], ["due", "Due"], ["completed", "Completed"]];
		const buttons = options.map(([value, label]) => {
			const btn = seg.createEl("button", { cls: "tt-seg-btn", text: label });
			btn.addEventListener("click", () => {
				if (this.trendBy === value) return;
				this.trendBy = value;
				draw(true);
			});
			return [value, btn] as const;
		});

		const draw = (animateNow: boolean) => {
			for (const [value, btn] of buttons) btn.toggleClass("is-active", value === this.trendBy);
			this.trendChart?.destroy();
			this.trendChart = null;
			body.empty();

			const trend = statusOverTime(tasks, this.trendBy);
			const what = { created: "created", due: "due", completed: "closed (done or failed)" }[this.trendBy];
			const missing = { created: "", due: "no due date", completed: "not closed yet" }[this.trendBy];
			sub.setText(
				`Tasks ${what} per ${trend.unit}, by their current status` +
					(trend.skipped && missing ? ` · ${trend.skipped} with ${missing} not shown` : "")
			);

			if (trend.labels.length === 0) {
				body.createDiv({
					cls: "tt-card-empty",
					text: this.trendBy === "due" ? "No tasks have a due date yet." : "No tasks are done or failed yet.",
				});
				return;
			}
			const canvas = body.createDiv({ cls: "tt-chart tt-chart-wide" }).createEl("canvas");
			this.trendChart = statusTrendChart(canvas, trend, animateNow);
		};
		draw(animate);
	}

	private render(): void {
		this.destroyCharts();
		const root = this.contentEl;
		root.empty();
		root.addClass("tt-view", "tt-dash");

		const store = this.plugin.store;
		const projects = store.getProjects();
		const allTasks = store.getTasks();
		const project = projects.find((p) => p.id === this.projectScope) ?? null;
		if (!project) this.projectScope = "all";
		const tasks = project ? allTasks.filter((t) => t.project?.id === project.id) : allTasks;

		this.renderHeader(root, projects, project, tasks.length);

		if (tasks.length === 0) {
			root.createDiv({
				cls: "tt-empty",
				text: project ? "No tasks in this project yet." : "No tasks yet. Create one with the \"New task\" button.",
			});
			return;
		}

		const summary = summarize(tasks);
		const upcoming = upcomingTasks(tasks);
		this.renderKpis(root, summary, upcoming.length);

		const animate = !this.hasRendered;
		this.hasRendered = true;

		// Needs attention
		const overdue = overdueTasks(tasks);
		if (overdue.length || upcoming.length) {
			section(root, "Needs attention");
			const grid = root.createDiv({ cls: "tt-grid tt-grid-lists" });
			this.taskListCard(grid, "Overdue", overdue, "Nothing overdue.", !project, "overdue");
			this.taskListCard(grid, "Due in the next 7 days", upcoming, "Nothing due this week.", !project, "upcoming");
		}

		// Projects comparison
		if (!project) this.renderProjects(root, projects, allTasks);

		// Progress over time
		section(root, "Progress over time");
		const overTime = root.createDiv({ cls: "tt-stack" });
		this.renderTrendCard(overTime, tasks, animate);

		const points = burndown(tasks);
		this.chartCard(
			overTime,
			"Burndown",
			"Open tasks left: actual vs. planned by due dates · above the plan = behind schedule",
			(c) => burndownChart(c, points, animate),
			"",
			"tt-chart-wide"
		);

		// Breakdown
		section(root, "Breakdown");
		const grid = root.createDiv({ cls: "tt-grid" });
		const open = tasks.filter((t) => !isClosed(t.status));
		const openStatuses = STATUSES.filter((s) => !isClosed(s));
		this.chartCard(
			grid,
			"Remaining work by priority",
			`${open.length} open task${open.length === 1 ? "" : "s"}`,
			open.length
				? (c) =>
						barChart(
							c,
							[...PRIORITIES].reverse().map((p) => PRIORITY_LABELS[p]), // High first
							openStatuses.map((s) => ({
								label: STATUS_LABELS[s],
								data: [...PRIORITIES].reverse().map((p) => open.filter((t) => t.priority === p && t.status === s).length),
								backgroundColor: STATUS_COLORS[s],
							})),
							animate,
							{ horizontal: true, stacked: true }
						)
				: null,
			"All tasks are done. 🎉"
		);

		const categories = countByCategory(tasks);
		this.chartCard(
			grid,
			"Tasks by category",
			"Top categories",
			categories.length && !(categories.length === 1 && categories[0][0] === "none")
				? (c) =>
						barChart(
							c,
							categories.map(([name]) => name),
							[{ label: "Tasks", data: categories.map(([, n]) => n), backgroundColor: CATEGORY_COLOR }],
							animate,
							{ horizontal: true }
						)
				: null,
			"Add categories to tasks to see this breakdown."
		);

		// Time
		section(root, "Time");
		const timed = estimateVsSpent(tasks);
		this.chartCard(
			root,
			"Estimate vs actual",
			"Hours per task — red bars went over the estimate",
			timed.length ? (c) => estimateChart(c, timed, animate) : null,
			"Add estimates or track time with the ▶ timer to see this chart.",
			timed.length > 5 ? "tt-chart-tall" : ""
		);
	}

	private renderHeader(root: HTMLElement, projects: Project[], project: Project | null, taskCount: number): void {
		const bar = root.createDiv({ cls: "tt-dash-header" });
		const text = bar.createDiv({ cls: "tt-dash-heading" });
		if (project) {
			const back = text.createEl("button", { cls: "tt-back", attr: { "aria-label": "Back to all projects" } });
			setIcon(back.createSpan({ cls: "tt-back-icon" }), "arrow-left");
			back.appendText("All projects");
			back.addEventListener("click", () => {
				this.projectScope = "all";
				this.render();
			});
		}
		text.createDiv({ cls: "tt-dash-eyebrow", text: project ? "Project" : "Overview" });
		text.createEl("h2", { cls: "tt-dash-title", text: project ? project.name : "All projects" });
		text.createDiv({
			cls: "tt-dash-sub",
			text: project
				? `${taskCount} task${taskCount === 1 ? "" : "s"}`
				: `${projects.length} project${projects.length === 1 ? "" : "s"} · ${taskCount} task${taskCount === 1 ? "" : "s"}`,
		});

		const controls = bar.createDiv({ cls: "tt-dash-controls" });
		const sel = controls.createEl("select", { cls: "dropdown" });
		sel.createEl("option", { value: "all", text: "All projects" });
		for (const p of projects) sel.createEl("option", { value: p.id, text: p.name });
		sel.value = this.projectScope;
		sel.addEventListener("change", () => {
			this.projectScope = sel.value;
			this.render();
		});
		if (project) {
			const open = controls.createEl("button", { text: "Open note" });
			open.addEventListener("click", () => this.openFile(project.file));
		}
		const newBtn = controls.createEl("button", { cls: "mod-cta", text: "New task" });
		newBtn.addEventListener("click", () => this.plugin.openNewTaskModal(project));
	}

	private renderKpis(root: HTMLElement, s: Summary, dueSoon: number): void {
		// Row 1: Progress as a wide tile — big % on the left, stacked status bar + legend on the right.
		const progress = kpi(root, "Progress", `${s.progress}%`, ACCENT.purple);
		progress.addClass("tt-kpi-hero");
		progress.createDiv({ cls: "tt-kpi-sub", text: `${s.byStatus.done} of ${s.total} done` });
		const detail = progress.createDiv({ cls: "tt-kpi-hero-detail" });
		const bar = detail.createDiv({ cls: "tt-stackbar", attr: { role: "img", "aria-label": STATUSES.map((st) => `${STATUS_LABELS[st]} ${s.byStatus[st]}`).join(", ") } });
		const legend = detail.createDiv({ cls: "tt-legend" });
		for (const st of STACK_ORDER) {
			if (s.byStatus[st]) {
				bar.createDiv({ cls: "tt-stackbar-seg" }).setAttr(
					"style",
					`flex: ${s.byStatus[st]}; background: ${STATUS_COLORS[st]}`
				);
			}
			const item = legend.createSpan({ cls: "tt-legend-item" });
			item.createSpan({ cls: "tt-legend-dot" }).setAttr("style", `background: ${STATUS_COLORS[st]}`);
			item.appendText(`${STATUS_LABELS[st]} ${s.byStatus[st]}`);
		}

		// Row 2: the three smaller tiles.
		const row = root.createDiv({ cls: "tt-kpis" });
		const overdue = kpi(row, "Overdue", `${s.overdue}`, s.overdue ? ACCENT.red : ACCENT.green);
		overdue.createDiv({ cls: "tt-kpi-sub", text: s.overdue ? "past their due date" : "nothing late" });

		const soon = kpi(row, "Due this week", `${dueSoon}`, ACCENT.blue);
		soon.createDiv({ cls: "tt-kpi-sub", text: `${s.open} open in total` });

		// Hours: spent vs estimate as a budget bar (red when over).
		const hours = kpi(row, "Hours", `${s.spent}h`, ACCENT.gold);
		if (s.estimate > 0) {
			const pct = Math.min(100, Math.round((s.spent / s.estimate) * 100));
			const over = s.spent > s.estimate;
			const track = hours.createDiv({ cls: "tt-progress" });
			track.createDiv({ cls: `tt-progress-fill${over ? " is-over" : ""}` }).setAttr("style", `width: ${pct}%`);
			hours.createDiv({ cls: "tt-kpi-sub", text: `of ${s.estimate}h estimated${over ? " · over budget" : ""}` });
		} else {
			hours.createDiv({ cls: "tt-kpi-sub", text: "no estimates yet" });
		}
	}

	/** All-projects mode: aligned rows so progress bars are easy to compare. Click a row to drill in. */
	private renderProjects(root: HTMLElement, projects: Project[], tasks: Task[]): void {
		const rows = projectRows(projects, tasks).sort((a, b) => b.summary.progress - a.summary.progress);
		const orphans = tasks.filter((t) => !t.project);
		if (!rows.length && !orphans.length) return;

		section(root, "Projects");
		const table = root.createDiv({ cls: "tt-ptable" });
		const head = table.createDiv({ cls: "tt-prow tt-prow-head" });
		for (const h of ["Project", "Status", "Done", "Overdue", "Hours"]) head.createSpan({ text: h });

		const addRow = (name: string, s: Summary, onClick: (() => void) | null) => {
			const row = table.createDiv({ cls: `tt-prow${onClick ? " is-clickable" : " is-muted"}` });
			if (onClick) row.addEventListener("click", onClick);
			row.createSpan({ cls: "tt-prow-name", text: name });
			const bar = row.createDiv({ cls: "tt-stackbar" });
			for (const st of STACK_ORDER) {
				if (s.byStatus[st]) bar.createDiv({ cls: "tt-stackbar-seg" }).setAttr("style", `flex: ${s.byStatus[st]}; background: ${STATUS_COLORS[st]}`);
			}
			row.createSpan({ cls: "tt-num", text: `${s.byStatus.done}/${s.total} · ${s.progress}%` });
			row.createSpan({ cls: `tt-num${s.overdue ? " tt-overdue" : " tt-muted"}`, text: s.overdue ? `${s.overdue}` : "—" });
			row.createSpan({ cls: "tt-num tt-muted", text: s.estimate ? `${s.spent} / ${s.estimate}h` : `${s.spent}h` });
		};

		for (const { project, summary } of rows) {
			addRow(project.name, summary, () => {
				this.projectScope = project.id;
				this.render();
			});
		}
		// Tasks whose project link is missing/broken — shown so they don't silently disappear.
		if (orphans.length) addRow("No project", summarize(orphans), null);
	}

	private chartCard(
		parent: HTMLElement,
		title: string,
		sub: string,
		build: ((canvas: HTMLCanvasElement) => Chart) | null,
		emptyText: string,
		chartCls = ""
	): void {
		const card = parent.createDiv({ cls: "tt-card" });
		const head = card.createDiv({ cls: "tt-card-head" });
		head.createDiv({ cls: "tt-card-title", text: title });
		head.createDiv({ cls: "tt-card-sub", text: sub });
		if (!build) {
			card.createDiv({ cls: "tt-card-empty", text: emptyText });
			return;
		}
		const canvas = card.createDiv({ cls: `tt-chart ${chartCls}`.trim() }).createEl("canvas");
		this.charts.push(build(canvas));
	}

	private taskListCard(
		parent: HTMLElement,
		title: string,
		tasks: Task[],
		emptyText: string,
		showProject: boolean,
		kind: "overdue" | "upcoming"
	): void {
		const card = parent.createDiv({ cls: `tt-card tt-card-${kind}` });
		const head = card.createDiv({ cls: "tt-card-head tt-card-head-row" });
		head.createDiv({ cls: "tt-card-title", text: title });
		head.createSpan({ cls: "tt-count", text: `${tasks.length}` });

		if (tasks.length === 0) {
			card.createDiv({ cls: "tt-card-empty tt-card-empty-sm", text: emptyText });
			return;
		}
		const list = card.createDiv({ cls: "tt-list" });
		const now = moment(today());
		for (const t of tasks.slice(0, 8)) {
			const item = list.createDiv({ cls: "tt-list-item" });
			item.createSpan({ cls: `tt-dot tt-prio-dot-${t.priority}`, attr: { "aria-label": `${PRIORITY_LABELS[t.priority]} priority` } });
			const text = item.createDiv({ cls: "tt-list-text" });
			const link = text.createEl("a", { cls: "tt-title", text: t.title });
			link.addEventListener("click", () => this.openFile(t.file));
			if (showProject) text.createDiv({ cls: "tt-list-project", text: t.project?.name ?? "No project" });
			const days = moment(t.due).diff(now, "days");
			item.createSpan({
				cls: `tt-due-badge${kind === "overdue" ? " is-late" : days <= 1 ? " is-soon" : ""}`,
				text: kind === "overdue" ? `${-days}d late` : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days}d`,
				attr: { "aria-label": t.due ?? "" },
			});
		}
		if (tasks.length > 8) list.createDiv({ cls: "tt-list-more", text: `+ ${tasks.length - 8} more` });
	}

	private openFile(file: TFile): void {
		this.app.workspace.getLeaf(false).openFile(file);
	}
}

function section(parent: HTMLElement, label: string): void {
	parent.createDiv({ cls: "tt-section", text: label });
}

function kpi(parent: HTMLElement, label: string, value: string, accent: string): HTMLElement {
	const tile = parent.createDiv({ cls: "tt-kpi" });
	tile.setAttr("style", `--c: ${accent}`);
	tile.createDiv({ cls: "tt-kpi-label", text: label });
	tile.createDiv({ cls: "tt-kpi-value", text: value });
	return tile;
}
