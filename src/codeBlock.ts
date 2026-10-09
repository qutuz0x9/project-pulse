import { MarkdownPostProcessorContext, MarkdownRenderChild, moment, Notice, setIcon } from "obsidian";
import { summarize, upcomingTasks } from "./analytics";
import { taskBadges } from "./badges";
import type ProjectPulsePlugin from "./main";
import { formatClock } from "./pomodoro";
import { today } from "./store";
import { TaskSuggestModal } from "./TaskSuggestModal";
import { isBlocked, isClosed, PRIORITY_RANK, Project, STATUS_LABELS, Task, TaskStatus } from "./types";

/**
 * ```project-pulse
 * view: tasks | today | stats | pomodoro   (optional, default tasks)
 * project: Study Docker   (optional — defaults to the note's own project, or all projects)
 * show: open | all        (optional, default open — tasks view only)
 * limit: 10               (optional, default 10 — tasks and today views)
 * ```
 * - tasks:    progress bar + open tasks
 * - today:    overdue, due today and in progress
 * - stats:    the dashboard's 4 KPI tiles (progress, overdue, due this week, hours)
 * - pomodoro: compact timer with start/pause/stop and today's 🍅 count
 * Everything updates live.
 */
export function registerCodeBlock(plugin: ProjectPulsePlugin): void {
	// "task-tracker" is the plugin's old name — still accepted so existing notes keep rendering.
	for (const lang of ["project-pulse", "task-tracker"]) {
		plugin.registerMarkdownCodeBlockProcessor(lang, (source, el, ctx) => {
			ctx.addChild(new TaskBlock(el, plugin, parseOptions(source), ctx));
		});
	}
}

type BlockView = "tasks" | "today" | "stats" | "pomodoro";

interface BlockOptions {
	view: BlockView;
	project: string | null;
	show: "open" | "all";
	limit: number;
}

function parseOptions(source: string): BlockOptions {
	const opts: BlockOptions = { view: "tasks", project: null, show: "open", limit: 10 };
	for (const line of source.split("\n")) {
		const m = line.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
		if (!m) continue;
		const [, key, value] = m;
		if (key === "view" && ["tasks", "today", "stats", "pomodoro"].includes(value)) opts.view = value as BlockView;
		if (key === "project") opts.project = value.replace(/^\[\[|\]\]$/g, "");
		if (key === "show" && (value === "all" || value === "open")) opts.show = value;
		if (key === "limit" && Number(value) > 0) opts.limit = Math.floor(Number(value));
	}
	return opts;
}

const STACK_ORDER: TaskStatus[] = ["done", "failed", "in-progress", "todo"];
const ACCENT = { purple: "155, 93, 229", red: "220, 38, 38", green: "13, 148, 136", blue: "37, 99, 235", gold: "192, 131, 6" };

/** Lives as long as the rendered block; re-renders when tasks (or the Pomodoro) change. */
class TaskBlock extends MarkdownRenderChild {
	private clockEl: HTMLElement | null = null;

	constructor(
		el: HTMLElement,
		private plugin: ProjectPulsePlugin,
		private opts: BlockOptions,
		private ctx: MarkdownPostProcessorContext
	) {
		super(el);
	}

	onload(): void {
		this.registerEvent(this.plugin.store.on("changed", () => this.render()));
		if (this.opts.view === "pomodoro") {
			this.registerEvent(this.plugin.pomodoro.on("changed", () => this.render()));
			this.registerEvent(this.plugin.pomodoro.on("tick", () => this.updateClock()));
		}
		this.render();
	}

	/** Which project to show: `project:` option → the note itself if it's a project → the note's task's project → all. */
	private project(): Project | null | "missing" {
		const projects = this.plugin.store.getProjects();
		if (this.opts.project) {
			const name = this.opts.project.toLowerCase();
			return projects.find((p) => p.name.toLowerCase() === name || p.file.basename.toLowerCase() === name) ?? "missing";
		}
		const file = this.plugin.app.vault.getFileByPath(this.ctx.sourcePath);
		return file ? this.plugin.store.projectForFile(file) : null;
	}

	private render(): void {
		const el = this.containerEl;
		el.empty();
		el.className = `tt-block tt-block-${this.opts.view}`;
		this.clockEl = null;

		if (this.opts.view === "pomodoro") return this.renderPomodoro(el);

		const project = this.project();
		if (project === "missing") {
			el.createDiv({ cls: "tt-block-empty", text: `Project Pulse: no project named "${this.opts.project}".` });
			return;
		}
		const tasks = this.plugin.store.getTasks().filter((t) => !project || t.project?.id === project.id);
		if (this.opts.view === "today") this.renderToday(el, tasks, !project);
		else if (this.opts.view === "stats") this.renderStats(el, tasks);
		else this.renderTasks(el, tasks, project);
	}

	// ---------- view: tasks ----------

	private renderTasks(el: HTMLElement, tasks: Task[], project: Project | null): void {
		const done = tasks.filter((t) => t.status === "done").length;
		const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

		// Header: name + % + stacked status bar + counts
		const head = el.createDiv({ cls: "tt-block-head" });
		head.createSpan({ cls: "tt-block-title", text: project ? project.name : "All projects" });
		head.createSpan({ cls: "tt-block-pct", text: `${pct}% done` });
		this.statusBar(el, tasks);
		const counts = el.createDiv({ cls: "tt-legend" });
		for (const s of STACK_ORDER) {
			const item = counts.createSpan({ cls: "tt-legend-item" });
			item.createSpan({ cls: `tt-legend-dot tt-status-bg-${s}` });
			item.appendText(`${STATUS_LABELS[s]} ${tasks.filter((t) => t.status === s).length}`);
		}

		const shown = tasks
			.filter((t) => this.opts.show === "all" || !isClosed(t.status))
			.sort(
				(a, b) =>
					Number(isClosed(a.status)) - Number(isClosed(b.status)) ||
					PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
					(a.due ?? "9999").localeCompare(b.due ?? "9999")
			);
		const list = el.createDiv({ cls: "tt-block-list" });
		if (shown.length === 0) list.createDiv({ cls: "tt-block-empty", text: tasks.length ? "No open tasks. 🎉" : "No tasks yet." });
		for (const t of shown.slice(0, this.opts.limit)) this.row(list, t, !project);
		if (shown.length > this.opts.limit) list.createDiv({ cls: "tt-block-more", text: `+ ${shown.length - this.opts.limit} more` });

		const add = el.createEl("button", { cls: "tt-block-add" });
		setIcon(add.createSpan(), "plus");
		add.createSpan({ text: "New task" });
		add.addEventListener("click", () => this.plugin.openNewTaskModal(project));
	}

	// ---------- view: today ----------

	private renderToday(el: HTMLElement, tasks: Task[], showProject: boolean): void {
		const now = today();
		const open = tasks.filter((t) => !isClosed(t.status));
		const groups: [string, string, Task[]][] = [
			["Overdue", "is-late", open.filter((t) => t.due !== null && t.due < now)],
			["Due today", "is-today", open.filter((t) => t.due === now)],
			["In progress", "is-progress", open.filter((t) => t.status === "in-progress" && !(t.due !== null && t.due <= now))],
		];
		const total = groups.reduce((a, [, , list]) => a + list.length, 0);

		const head = el.createDiv({ cls: "tt-block-head" });
		head.createSpan({ cls: "tt-block-title", text: `Today · ${moment().format("ddd, MMM D")}` });
		const open_ = head.createEl("a", { cls: "tt-block-link", text: "Open Today ›" });
		open_.addEventListener("click", () => this.plugin.openTodayView());

		if (total === 0) {
			el.createDiv({ cls: "tt-block-empty", text: "Nothing overdue, due today or in progress. 🎉" });
			return;
		}
		let left = this.opts.limit;
		for (const [label, cls, list] of groups) {
			if (!list.length || left <= 0) continue;
			const title = el.createDiv({ cls: `tt-block-group ${cls}` });
			title.createSpan({ text: label });
			title.createSpan({ cls: "tt-today-count", text: `${list.length}` });
			const box = el.createDiv({ cls: "tt-block-list" });
			const sorted = [...list].sort(
				(a, b) => Number(isBlocked(a)) - Number(isBlocked(b)) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
			);
			for (const t of sorted.slice(0, left)) this.row(box, t, showProject);
			left -= list.length;
		}
		if (left < 0) el.createDiv({ cls: "tt-block-more", text: `+ ${-left} more in the Today view` });
	}

	// ---------- view: stats ----------

	private renderStats(el: HTMLElement, tasks: Task[]): void {
		const s = summarize(tasks);
		const dueSoon = upcomingTasks(tasks).length;
		const row = el.createDiv({ cls: "tt-kpis" });

		const progress = kpi(row, "Progress", `${s.progress}%`, ACCENT.purple);
		this.statusBar(progress, tasks);
		progress.createDiv({ cls: "tt-kpi-sub", text: `${s.byStatus.done} of ${s.total} done` });

		kpi(row, "Overdue", `${s.overdue}`, s.overdue ? ACCENT.red : ACCENT.green).createDiv({
			cls: "tt-kpi-sub",
			text: s.overdue ? "past their due date" : "nothing late",
		});
		kpi(row, "Due this week", `${dueSoon}`, ACCENT.blue).createDiv({ cls: "tt-kpi-sub", text: `${s.open} open in total` });

		const hours = kpi(row, "Hours", `${s.spent}h`, ACCENT.gold);
		if (s.estimate > 0) {
			const over = s.spent > s.estimate;
			hours
				.createDiv({ cls: "tt-progress" })
				.createDiv({ cls: `tt-progress-fill${over ? " is-over" : ""}` })
				.setCssProps({ "--tt-pct": `${Math.min(100, Math.round((s.spent / s.estimate) * 100))}%` });
			hours.createDiv({ cls: "tt-kpi-sub", text: `of ${s.estimate}h estimated${over ? " · over budget" : ""}` });
		} else {
			hours.createDiv({ cls: "tt-kpi-sub", text: "no estimates yet" });
		}
	}

	// ---------- view: pomodoro ----------

	private renderPomodoro(el: HTMLElement): void {
		const pomo = this.plugin.pomodoro;
		const s = pomo.state;
		const task = pomo.task();
		const phase = s.phase;

		const left = el.createDiv({ cls: "tt-block-pomo-info" });
		const status = pomo.isPaused()
			? "Paused"
			: phase === "focus"
				? "Focusing"
				: phase === "short-break"
					? "Short break"
					: phase === "long-break"
						? "Long break"
						: "Ready";
		left.createDiv({ cls: `tt-block-pomo-status is-${phase}`, text: `🍅 ${status}` });
		if (task) {
			const link = left.createEl("a", { cls: "tt-title", text: task.basename });
			link.addEventListener("click", () => this.plugin.app.workspace.getLeaf(false).openFile(task));
		} else {
			left.createDiv({ cls: "tt-block-pomo-none", text: "No task picked" });
		}
		const count = left.createEl("a", { cls: "tt-block-link", text: `${pomo.completedToday()} completed today ›` });
		count.addEventListener("click", () => this.plugin.openPomodoroStats());

		this.clockEl = el.createDiv({ cls: "tt-block-pomo-clock" });
		this.updateClock();

		const actions = el.createDiv({ cls: "tt-block-pomo-actions" });
		const button = (text: string, onClick: () => void, cta = false) => {
			const b = actions.createEl("button", { text, cls: cta ? "mod-cta" : "" });
			b.addEventListener("click", onClick);
		};
		if (phase === "idle") {
			if (task) button("Start focus", () => pomo.startFocus(), true);
			else
				button(
					"Choose a task",
					() => new TaskSuggestModal(this.plugin.app, this.openTasks(), (t) => pomo.selectTask(t.file.path)).open(),
					true
				);
		} else if (pomo.isPaused()) {
			button("Resume", () => pomo.resume(), true);
			button("Stop", () => pomo.stop());
		} else if (phase === "focus") {
			button("Pause", () => pomo.pause());
			button("Stop", () => pomo.stop());
		} else {
			button("Skip break", () => pomo.skipBreak(), true);
		}
		const panel = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Open Pomodoro panel" } });
		setIcon(panel, "panel-right-open");
		panel.addEventListener("click", () => this.plugin.activatePomodoroView());
	}

	private updateClock(): void {
		this.clockEl?.setText(formatClock(this.plugin.pomodoro.remainingMs()));
	}

	/** Open tasks for the picker — earliest due first (no due date last), then priority. */
	private openTasks(): Task[] {
		return this.plugin.store
			.getTasks()
			.filter((t) => !isClosed(t.status))
			.sort(
				(a, b) =>
					(a.due ?? "9999").localeCompare(b.due ?? "9999") ||
					PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
					a.title.localeCompare(b.title)
			);
	}

	// ---------- shared ----------

	private statusBar(parent: HTMLElement, tasks: Task[]): void {
		const bar = parent.createDiv({ cls: "tt-stackbar" });
		for (const s of STACK_ORDER) {
			const n = tasks.filter((t) => t.status === s).length;
			if (n) bar.createDiv({ cls: `tt-stackbar-seg tt-status-bg-${s}` }).setCssProps({ "--tt-flex": String(n) });
		}
	}

	private row(list: HTMLElement, t: Task, showProject: boolean): void {
		const row = list.createDiv({ cls: `tt-block-row${isBlocked(t) ? " is-blocked" : ""}${isClosed(t.status) ? " is-closed" : ""}` });
		const check = row.createEl("button", { cls: `tt-check${t.status === "done" ? " is-done" : ""}`, attr: { "aria-label": "Mark done" } });
		if (t.status === "done") setIcon(check, "check");
		check.disabled = isClosed(t.status);
		check.addEventListener("click", () =>
			this.plugin.store.setStatus(t.file, "done").catch((e) => new Notice(`Project Pulse: ${e instanceof Error ? e.message : "save failed"}`))
		);
		row.createSpan({ cls: `tt-dot tt-prio-dot-${t.priority}` });
		const text = row.createDiv({ cls: "tt-today-text" });
		const link = text.createEl("a", { cls: "tt-title", text: t.title });
		link.addEventListener("click", () => this.plugin.app.workspace.getLeaf(false).openFile(t.file));
		const meta = text.createDiv({ cls: "tt-task-meta" });
		if (showProject && t.project) meta.createSpan({ cls: "tt-task-project", text: t.project.name });
		if (t.status === "in-progress") meta.createSpan({ cls: "tt-badge-mini is-progress", text: "In progress" });
		taskBadges(meta, t);
		if (!meta.hasChildNodes()) meta.remove();
		if (t.due && !isClosed(t.status)) {
			const days = moment(t.due).diff(moment(today()), "days");
			row.createSpan({
				cls: `tt-due-badge${days < 0 ? " is-late" : days <= 1 ? " is-soon" : ""}`,
				text: days < 0 ? `${-days}d late` : days === 0 ? "Today" : days === 1 ? "Tomorrow" : moment(t.due).format("MMM D"),
			});
		}
	}
}

function kpi(parent: HTMLElement, label: string, value: string, accent: string): HTMLElement {
	const tile = parent.createDiv({ cls: "tt-kpi" });
	tile.setCssProps({ "--c": accent });
	tile.createDiv({ cls: "tt-kpi-label", text: label });
	tile.createDiv({ cls: "tt-kpi-value", text: value });
	return tile;
}
