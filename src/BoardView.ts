import { ItemView, Menu, moment, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { isOverdue } from "./analytics";
import type ProjectPulsePlugin from "./main";
import { today } from "./store";
import { taskBadges } from "./badges";
import { timerButton } from "./timer";
import {
	isBlocked,
	isClosed,
	PRIORITIES,
	PRIORITY_LABELS,
	PRIORITY_RANK,
	Project,
	STATUSES,
	STATUS_LABELS,
	Task,
	TaskPriority,
	TaskStatus,
} from "./types";

export const VIEW_TYPE_BOARD = "project-pulse-board";

// Data type used to carry the dragged task's path between drag events.
const DRAG_TYPE = "text/project-pulse-path";

// Done / Failed columns show this many cards until "Show all" is clicked.
const CLOSED_LIMIT = 8;

/**
 * Layout: header (title + search + New task) → filter row → 4 status columns.
 * Typing in search only redraws the columns, so the input keeps focus.
 */
export class BoardView extends ItemView {
	private projectFilter = "all"; // "all" or a project id
	private priorityFilter: "all" | TaskPriority = "all";
	private query = "";
	private expanded = new Set<TaskStatus>(); // closed columns showing all cards
	private boardEl: HTMLElement | null = null;
	private subEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: ProjectPulsePlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_BOARD;
	}

	getDisplayText(): string {
		return "Task board";
	}

	getIcon(): string {
		return "kanban";
	}

	async onOpen(): Promise<void> {
		this.registerEvent(this.plugin.store.on("changed", () => this.render()));
		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("tt-view", "tt-dash", "tt-board-view");

		const projects = this.plugin.store.getProjects();
		if (!projects.some((p) => p.id === this.projectFilter)) this.projectFilter = "all";

		// Header
		const header = root.createDiv({ cls: "tt-dash-header" });
		const heading = header.createDiv({ cls: "tt-dash-heading" });
		heading.createDiv({ cls: "tt-dash-eyebrow", text: "Tasks" });
		heading.createEl("h2", { cls: "tt-dash-title", text: "Board" });
		this.subEl = heading.createDiv({ cls: "tt-dash-sub" });

		const controls = header.createDiv({ cls: "tt-dash-controls" });
		const search = controls.createDiv({ cls: "tt-search" });
		setIcon(search.createSpan({ cls: "tt-search-icon" }), "search");
		const input = search.createEl("input", { type: "search", attr: { placeholder: "Search tasks…" } });
		input.value = this.query;
		input.addEventListener("input", () => {
			this.query = input.value;
			this.renderBoard();
		});
		const newBtn = controls.createEl("button", { cls: "mod-cta", text: "New task" });
		newBtn.addEventListener("click", () => this.plugin.openNewTaskModal(this.currentProject()));

		// Filters + hint
		const filters = root.createDiv({ cls: "tt-filters" });
		const projSel = filters.createEl("select", { cls: "dropdown" });
		projSel.createEl("option", { value: "all", text: "All projects" });
		for (const p of projects) projSel.createEl("option", { value: p.id, text: p.name });
		projSel.value = this.projectFilter;
		projSel.addEventListener("change", () => {
			this.projectFilter = projSel.value;
			this.renderBoard();
		});
		const prioSel = filters.createEl("select", { cls: "dropdown" });
		prioSel.createEl("option", { value: "all", text: "All priorities" });
		for (const p of PRIORITIES) prioSel.createEl("option", { value: p, text: PRIORITY_LABELS[p] });
		prioSel.value = this.priorityFilter;
		prioSel.addEventListener("change", () => {
			this.priorityFilter = prioSel.value as "all" | TaskPriority;
			this.renderBoard();
		});
		filters.createSpan({ cls: "tt-hint", text: "Drag cards between columns · right-click for more" });

		this.boardEl = root.createDiv({ cls: "tt-board" });
		this.renderBoard();
	}

	private currentProject(): Project | null {
		return this.plugin.store.getProjects().find((p) => p.id === this.projectFilter) ?? null;
	}

	private renderBoard(): void {
		const board = this.boardEl;
		if (!board) return;
		board.empty();

		const q = this.query.trim().toLowerCase();
		const tasks = this.plugin.store.getTasks().filter((t) => {
			if (this.projectFilter !== "all" && t.project?.id !== this.projectFilter) return false;
			if (this.priorityFilter !== "all" && t.priority !== this.priorityFilter) return false;
			if (q && ![t.title, t.project?.name ?? "", ...t.category].some((s) => s.toLowerCase().includes(q))) return false;
			return true;
		});

		const now = today();
		const open = tasks.filter((t) => !isClosed(t.status)).length;
		const overdue = tasks.filter((t) => isOverdue(t, now)).length;
		this.subEl?.setText(`${open} open · ${tasks.length - open} closed` + (overdue ? ` · ${overdue} overdue` : ""));

		for (const status of STATUSES) {
			const colTasks = sortForColumn(tasks.filter((t) => t.status === status), status);
			this.renderColumn(board, status, colTasks, now);
		}
	}

	private renderColumn(board: HTMLElement, status: TaskStatus, tasks: Task[], now: string): void {
		const col = board.createDiv({ cls: `tt-col tt-col-${status}` });
		const head = col.createDiv({ cls: "tt-col-head" });
		head.createSpan({ cls: "tt-col-title", text: STATUS_LABELS[status] });
		head.createSpan({ cls: "tt-col-count", text: `${tasks.length}` });
		const add = head.createEl("button", {
			cls: "clickable-icon tt-col-add",
			attr: { "aria-label": `New ${STATUS_LABELS[status]} task` },
		});
		setIcon(add, "plus");
		add.addEventListener("click", () => this.plugin.openNewTaskModal(this.currentProject(), status));

		const body = col.createDiv({ cls: "tt-col-body" });
		if (tasks.length === 0) body.createDiv({ cls: "tt-col-empty", text: "No tasks — drop one here" });

		const closed = isClosed(status);
		const limit = closed && !this.expanded.has(status) ? CLOSED_LIMIT : tasks.length;
		for (const task of tasks.slice(0, limit)) {
			if (closed) this.renderClosedCard(body, task);
			else this.renderCard(body, task, now);
		}
		if (tasks.length > limit) {
			const more = body.createEl("button", { cls: "tt-col-more", text: `Show all ${tasks.length}` });
			more.addEventListener("click", () => {
				this.expanded.add(status);
				this.renderBoard();
			});
		}

		// Drop target: the whole column.
		col.addEventListener("dragover", (e) => {
			if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
			e.preventDefault(); // allows dropping
			e.dataTransfer.dropEffect = "move";
			col.addClass("is-drop-target");
		});
		col.addEventListener("dragleave", (e) => {
			// Ignore leave events fired when moving over the column's own children.
			if (!col.contains(e.relatedTarget as Node | null)) col.removeClass("is-drop-target");
		});
		col.addEventListener("drop", (e) => {
			e.preventDefault();
			col.removeClass("is-drop-target");
			const path = e.dataTransfer?.getData(DRAG_TYPE);
			const task = path ? this.plugin.store.getTasks().find((t) => t.file.path === path) : undefined;
			if (task && task.status !== status) {
				// Move the card right away; the store's "changed" event re-renders after the note is saved.
				const card = this.contentEl.querySelector(`[data-path="${CSS.escape(task.file.path)}"]`);
				if (card) body.prepend(card);
				this.moveTask(task, status);
			}
		});
	}

	/** Card for Todo / In Progress: priority + due on top, title, project & chips, time and actions at the bottom. */
	private renderCard(parent: HTMLElement, task: Task, now: string): void {
		const card = this.cardShell(parent, task);

		const top = card.createDiv({ cls: "tt-kcard-top" });
		top.createSpan({ cls: `tt-prio-tag tt-prio-${task.priority}`, text: PRIORITY_LABELS[task.priority] });
		if (task.due) {
			const days = moment(task.due).diff(moment(now), "days");
			const late = isOverdue(task, now);
			top.createSpan({
				cls: `tt-due-badge${late ? " is-late" : days <= 1 ? " is-soon" : ""}`,
				text: late ? `${-days}d late` : relativeDay(days, task.due),
				attr: { "aria-label": moment(task.due).format("dddd, MMM D, YYYY") },
			});
		}

		this.cardTitle(card, task);

		const meta = card.createDiv({ cls: "tt-kcard-meta" });
		if (this.projectFilter === "all" && task.project) meta.createSpan({ cls: "tt-kcard-project", text: task.project.name });
		taskBadges(meta, task);
		for (const c of task.category) meta.createSpan({ cls: "tt-chip", text: c });
		if (!meta.hasChildNodes()) meta.remove();
		if (isBlocked(task)) card.addClass("is-blocked");

		const foot = card.createDiv({ cls: "tt-kcard-foot" });
		if (task.estimate || task.spent) {
			const time = foot.createDiv({ cls: "tt-kcard-time" });
			time.createSpan({ cls: "tt-num", text: `${task.spent}${task.estimate ? `/${task.estimate}` : ""}h` });
			if (task.estimate) {
				const bar = time.createDiv({ cls: "tt-time-bar" });
				bar.createDiv({ cls: `tt-time-fill${task.spent > task.estimate ? " is-over" : ""}` }).setCssProps({ "--tt-pct": `${Math.min(100, Math.round((task.spent / task.estimate) * 100))}%` });
			}
		}
		if (task.pomodoros > 0) foot.createSpan({ cls: "tt-kcard-pomos", text: `🍅 ${task.pomodoros}` });
		const actions = foot.createDiv({ cls: "tt-kcard-actions" });
		timerButton(actions, this.plugin, task.file);
		const more = actions.createEl("button", { cls: "clickable-icon tt-kcard-more", attr: { "aria-label": "More actions" } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (e) => {
			e.stopPropagation();
			this.cardMenu(task).showAtMouseEvent(e);
		});
	}

	/** Compact card for Done / Failed: title + project + when it closed. */
	private renderClosedCard(parent: HTMLElement, task: Task): void {
		const card = this.cardShell(parent, task);
		card.addClass("is-compact");
		this.cardTitle(card, task);
		const meta = card.createDiv({ cls: "tt-kcard-meta" });
		if (this.projectFilter === "all" && task.project) meta.createSpan({ cls: "tt-kcard-project", text: task.project.name });
		if (task.completed) {
			meta.createSpan({
				cls: "tt-kcard-closed",
				text: `${STATUS_LABELS[task.status]} ${moment(task.completed).format("MMM D")}`,
			});
		}
	}

	/** Draggable card with priority edge and right-click menu. */
	private cardShell(parent: HTMLElement, task: Task): HTMLElement {
		const card = parent.createDiv({
			cls: `tt-kcard tt-kcard-${task.priority}`,
			attr: { draggable: "true", "data-path": task.file.path },
		});
		if (this.plugin.timer.isRunning(task.file)) card.addClass("tt-timing");

		card.addEventListener("dragstart", (e) => {
			e.dataTransfer?.setData(DRAG_TYPE, task.file.path);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
			card.addClass("is-dragging");
		});
		card.addEventListener("dragend", () => card.removeClass("is-dragging"));

		// Right-click (or long-press on mobile, where drag & drop doesn't work).
		card.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.cardMenu(task).showAtMouseEvent(e);
		});
		return card;
	}

	private cardTitle(card: HTMLElement, task: Task): void {
		const title = card.createDiv({ cls: "tt-kcard-title", text: task.title });
		title.addEventListener("click", () => this.app.workspace.getLeaf(false).openFile(task.file));
	}

	private cardMenu(task: Task): Menu {
		const menu = new Menu();
		for (const s of STATUSES) {
			if (s === task.status) continue;
			menu.addItem((item) =>
				item
					.setTitle(`Move to ${STATUS_LABELS[s]}`)
					.setIcon("arrow-right")
					.onClick(() => this.moveTask(task, s))
			);
		}
		if (!isClosed(task.status)) {
			menu.addItem((item) =>
				item
					.setTitle("Start Pomodoro")
					.setIcon("timer")
					.onClick(() => this.plugin.startPomodoroFor(task.file))
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Edit task")
				.setIcon("pencil")
				.onClick(() => this.plugin.openEditTaskModal(task))
		);
		menu.addItem((item) =>
			item
				.setTitle("Open note")
				.setIcon("file-text")
				.onClick(() => this.app.workspace.getLeaf(false).openFile(task.file))
		);
		menu.addItem((item) =>
			item
				.setTitle("Delete task")
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(() => this.plugin.confirmDeleteTask(task.file))
		);
		return menu;
	}

	private moveTask(task: Task, status: TaskStatus): void {
		this.plugin.store
			.setStatus(task.file, status)
			.catch((e) => new Notice(`Project Pulse: ${e instanceof Error ? e.message : "save failed"}`));
	}
}

// Todo / In Progress: most urgent first. Done / Failed: most recently closed first.
function sortForColumn(tasks: Task[], status: TaskStatus): Task[] {
	if (isClosed(status)) {
		return [...tasks].sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? ""));
	}
	return [...tasks].sort(
		(a, b) =>
			PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
			(a.due ?? "9999").localeCompare(b.due ?? "9999") ||
			a.title.localeCompare(b.title)
	);
}

function relativeDay(days: number, date: string): string {
	if (days === 0) return "Today";
	if (days === 1) return "Tomorrow";
	if (days === -1) return "Yesterday";
	return moment(date).format("MMM D");
}
