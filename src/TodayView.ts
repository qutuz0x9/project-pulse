import { ItemView, moment, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { taskBadges } from "./badges";
import type TaskTrackerPlugin from "./main";
import { today } from "./store";
import { isBlocked, isClosed, PRIORITY_LABELS, PRIORITY_RANK, Task } from "./types";

export const VIEW_TYPE_TODAY = "task-tracker-today";

const COMING_UP_DAYS = 3;

/** One page to start the day: overdue → due today → in progress → coming up → done today. */
export class TodayView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private plugin: TaskTrackerPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_TODAY;
	}

	getDisplayText(): string {
		return "Today";
	}

	getIcon(): string {
		return "sun";
	}

	async onOpen(): Promise<void> {
		this.registerEvent(this.plugin.store.on("changed", () => this.render()));
		this.registerEvent(this.plugin.pomodoro.on("changed", () => this.render()));
		// Re-render after midnight so "today" moves on.
		this.registerInterval(window.setInterval(() => this.render(), 30 * 60_000));
		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("tt-view", "tt-dash", "tt-today");

		const now = today();
		const soon = moment().add(COMING_UP_DAYS, "days").format("YYYY-MM-DD");
		const all = this.plugin.store.getTasks();
		const open = all.filter((t) => !isClosed(t.status));

		const overdue = open.filter((t) => t.due !== null && t.due < now);
		const dueToday = open.filter((t) => t.due === now);
		const inProgress = open.filter((t) => t.status === "in-progress" && !(t.due !== null && t.due <= now));
		const comingUp = open.filter((t) => t.status !== "in-progress" && t.due !== null && t.due > now && t.due <= soon);
		const doneToday = all.filter((t) => t.status === "done" && t.completed === now);

		// Header
		const header = root.createDiv({ cls: "tt-dash-header" });
		const heading = header.createDiv({ cls: "tt-dash-heading" });
		heading.createDiv({ cls: "tt-dash-eyebrow", text: "Today" });
		heading.createEl("h2", { cls: "tt-dash-title", text: moment().format("dddd, MMM D") });
		const focus = this.plugin.pomodoro.completedToday();
		heading.createDiv({
			cls: "tt-dash-sub",
			text: `${overdue.length + dueToday.length} to finish today · ${doneToday.length} done · ${focus} 🍅`,
		});
		const controls = header.createDiv({ cls: "tt-dash-controls" });
		const pomo = controls.createEl("button", { text: "Pomodoro" });
		pomo.addEventListener("click", () => this.plugin.activatePomodoroView());
		const add = controls.createEl("button", { cls: "mod-cta", text: "Quick add" });
		add.addEventListener("click", () => this.plugin.openQuickAdd());

		if (!overdue.length && !dueToday.length && !inProgress.length && !comingUp.length) {
			root.createDiv({
				cls: "tt-empty",
				text: doneToday.length ? "All clear for today. 🎉" : "Nothing due today and nothing in progress. Use Quick add to plan something.",
			});
		}

		this.section(root, "Overdue", overdue, "is-late");
		this.section(root, "Due today", dueToday, "is-today");
		this.section(root, "In progress", inProgress, "is-progress");
		this.section(root, `Coming up · next ${COMING_UP_DAYS} days`, comingUp, "");
		this.section(root, "Done today", doneToday, "is-done");
	}

	private section(root: HTMLElement, label: string, tasks: Task[], cls: string): void {
		if (tasks.length === 0) return;
		const head = root.createDiv({ cls: `tt-section tt-today-section ${cls}`.trim() });
		head.createSpan({ text: label });
		head.createSpan({ cls: "tt-today-count", text: `${tasks.length}` });
		const list = root.createDiv({ cls: "tt-today-list" });
		const sorted = [...tasks].sort(
			(a, b) =>
				Number(isBlocked(a)) - Number(isBlocked(b)) || // blocked ones last
				PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
				(a.due ?? "9999").localeCompare(b.due ?? "9999")
		);
		for (const t of sorted) this.row(list, t);
	}

	private row(list: HTMLElement, task: Task): void {
		const now = today();
		const row = list.createDiv({ cls: `tt-today-row${isBlocked(task) ? " is-blocked" : ""}${isClosed(task.status) ? " is-closed" : ""}` });

		const check = row.createEl("button", {
			cls: `tt-check${task.status === "done" ? " is-done" : ""}`,
			attr: { "aria-label": task.status === "done" ? "Done" : "Mark done" },
		});
		if (task.status === "done") setIcon(check, "check");
		check.disabled = isClosed(task.status);
		check.addEventListener("click", () =>
			this.plugin.store.setStatus(task.file, "done").catch((e) => new Notice(`Task Tracker: ${e instanceof Error ? e.message : "save failed"}`))
		);

		row.createSpan({ cls: `tt-dot tt-prio-dot-${task.priority}`, attr: { "aria-label": `${PRIORITY_LABELS[task.priority]} priority` } });

		const text = row.createDiv({ cls: "tt-today-text" });
		const title = text.createEl("a", { cls: "tt-title", text: task.title });
		title.addEventListener("click", () => this.app.workspace.getLeaf(false).openFile(task.file));
		const meta = text.createDiv({ cls: "tt-task-meta" });
		if (task.project) meta.createSpan({ cls: "tt-task-project", text: task.project.name });
		taskBadges(meta, task);
		if (task.status === "in-progress") meta.createSpan({ cls: "tt-badge-mini is-progress", text: "In progress" });

		if (task.due && !isClosed(task.status)) {
			const days = moment(task.due).diff(moment(now), "days");
			row.createSpan({
				cls: `tt-due-badge${days < 0 ? " is-late" : days <= 1 ? " is-soon" : ""}`,
				text: days < 0 ? `${-days}d late` : days === 0 ? "Today" : days === 1 ? "Tomorrow" : moment(task.due).format("ddd"),
			});
		}

		if (!isClosed(task.status)) {
			const pomo = this.plugin.pomodoro;
			const running = pomo.state.phase === "focus" && pomo.state.taskPath === task.file.path;
			const start = row.createEl("button", {
				cls: `tt-today-pomo${running ? " is-running" : ""}`,
				text: running ? "🍅 Focusing" : "🍅 Start",
				attr: { "aria-label": running ? "Open Pomodoro" : "Start a Pomodoro on this task" },
			});
			start.addEventListener("click", () => (running ? this.plugin.activatePomodoroView() : this.plugin.startPomodoroFor(task.file)));
		}
	}
}
