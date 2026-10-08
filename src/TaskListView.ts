import { ItemView, moment, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { isOverdue } from "./analytics";
import type TaskTrackerPlugin from "./main";
import { taskBadges } from "./badges";
import { timerButton } from "./timer";
import { today } from "./store";
import { isClosed, PRIORITIES, PRIORITY_LABELS, PRIORITY_RANK, STATUSES, STATUS_LABELS, Task, TaskPriority, TaskStatus } from "./types";

export const VIEW_TYPE_TASK_LIST = "task-tracker-list";

type StatusFilter = "all" | "open" | TaskStatus;
type SortKey = "due" | "priority" | "created" | "title";

/**
 * Layout: header (title + search + New task) → filter row → summary → table.
 * Typing in search only redraws the table, so the input keeps focus.
 */
export class TaskListView extends ItemView {
	// Filters live only while the tab is open.
	private projectFilter = "all"; // "all" or a project id
	private statusFilter: StatusFilter = "open";
	private priorityFilter: "all" | TaskPriority = "all";
	private sortKey: SortKey = "due";
	private query = "";
	private bodyEl: HTMLElement | null = null;
	private subEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: TaskTrackerPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_TASK_LIST;
	}

	getDisplayText(): string {
		return "Task list";
	}

	getIcon(): string {
		return "list-checks";
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
		root.addClass("tt-view", "tt-dash", "tt-list-view");

		const projects = this.plugin.store.getProjects();
		if (!projects.some((p) => p.id === this.projectFilter)) this.projectFilter = "all";

		// Header
		const header = root.createDiv({ cls: "tt-dash-header" });
		const heading = header.createDiv({ cls: "tt-dash-heading" });
		heading.createDiv({ cls: "tt-dash-eyebrow", text: "Tasks" });
		heading.createEl("h2", { cls: "tt-dash-title", text: "Task list" });
		this.subEl = heading.createDiv({ cls: "tt-dash-sub" });

		const controls = header.createDiv({ cls: "tt-dash-controls" });
		const search = controls.createDiv({ cls: "tt-search" });
		setIcon(search.createSpan({ cls: "tt-search-icon" }), "search");
		const input = search.createEl("input", { type: "search", attr: { placeholder: "Search tasks…" } });
		input.value = this.query;
		input.addEventListener("input", () => {
			this.query = input.value;
			this.renderBody();
		});
		const btn = controls.createEl("button", { cls: "mod-cta", text: "New task" });
		btn.addEventListener("click", () => {
			const project = projects.find((p) => p.id === this.projectFilter) ?? null;
			this.plugin.openNewTaskModal(project);
		});

		// Filters
		const filters = root.createDiv({ cls: "tt-filters" });
		select(
			filters,
			[["all", "All projects"], ...projects.map((p): [string, string] => [p.id, p.name])],
			this.projectFilter,
			(v) => (this.projectFilter = v)
		);
		select(
			filters,
			[["open", "Open"], ["all", "All statuses"], ...STATUSES.map((s): [string, string] => [s, STATUS_LABELS[s]])],
			this.statusFilter,
			(v) => (this.statusFilter = v as StatusFilter)
		);
		select(
			filters,
			[["all", "All priorities"], ...PRIORITIES.map((p): [string, string] => [p, PRIORITY_LABELS[p]])],
			this.priorityFilter,
			(v) => (this.priorityFilter = v as "all" | TaskPriority)
		);
		select(
			filters,
			[["due", "Sort: Due date"], ["priority", "Sort: Priority"], ["created", "Sort: Newest"], ["title", "Sort: Title"]],
			this.sortKey,
			(v) => (this.sortKey = v as SortKey)
		);
		filters.querySelectorAll("select").forEach((el) => el.addEventListener("change", () => this.renderBody()));

		this.bodyEl = root.createDiv();
		this.renderBody();
	}

	/** Summary line + table (everything that depends on filters and search). */
	private renderBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();

		const tasks = this.sorted(this.filtered(this.plugin.store.getTasks()));
		const now = today();
		const overdue = tasks.filter((t) => isOverdue(t, now)).length;
		this.subEl?.setText(`${tasks.length} task${tasks.length === 1 ? "" : "s"}` + (overdue ? ` · ${overdue} overdue` : ""));

		if (tasks.length === 0) {
			body.createDiv({
				cls: "tt-empty",
				text: this.query ? `No tasks match "${this.query}".` : "No tasks match these filters.",
			});
			return;
		}
		this.renderTable(body, tasks, now);
	}

	private renderTable(parent: HTMLElement, tasks: Task[], now: string): void {
		const showProject = this.projectFilter === "all";
		const table = parent.createDiv({ cls: "tt-table-wrap" }).createEl("table", { cls: "tt-table" });
		const head = table.createEl("thead").createEl("tr");
		head.createEl("th", { cls: "tt-col-check" });
		for (const h of ["Task", "Status", "Priority", "Due", "Time", ""]) head.createEl("th", { text: h });

		const tbody = table.createEl("tbody");
		for (const task of tasks) {
			const row = tbody.createEl("tr", { cls: `tt-row tt-status-${task.status}` });
			if (this.plugin.timer.isRunning(task.file)) row.addClass("tt-timing");

			// ○ mark done
			const checkCell = row.createEl("td", { cls: "tt-col-check" });
			const check = checkCell.createEl("button", {
				cls: `tt-check${task.status === "done" ? " is-done" : task.status === "failed" ? " is-failed" : ""}`,
				attr: { "aria-label": isClosed(task.status) ? STATUS_LABELS[task.status] : "Mark done" },
			});
			if (task.status === "done") setIcon(check, "check");
			if (task.status === "failed") setIcon(check, "x");
			check.disabled = isClosed(task.status);
			check.addEventListener("click", () => this.save(this.plugin.store.setStatus(task.file, "done")));

			// Title + project + categories
			const cell = row.createEl("td", { cls: "tt-task-cell" });
			const link = cell.createEl("a", { cls: "tt-title", text: task.title });
			link.addEventListener("click", () => this.app.workspace.getLeaf(false).openFile(task.file));
			const meta = cell.createDiv({ cls: "tt-task-meta" });
			if (showProject && task.project) meta.createSpan({ cls: "tt-task-project", text: task.project.name });
			taskBadges(meta, task);
			for (const c of task.category) meta.createSpan({ cls: "tt-chip", text: c });
			if (!meta.hasChildNodes()) meta.remove();

			select(
				row.createEl("td"),
				STATUSES.map((s): [string, string] => [s, STATUS_LABELS[s]]),
				task.status,
				(v) => this.save(this.plugin.store.setStatus(task.file, v as TaskStatus)),
				`tt-pill tt-pill-${task.status}`
			);

			select(
				row.createEl("td"),
				PRIORITIES.map((p): [string, string] => [p, PRIORITY_LABELS[p]]),
				task.priority,
				(v) => this.save(this.plugin.store.setPriority(task.file, v as TaskPriority)),
				`tt-pill tt-prio-${task.priority}`
			);

			// Due as a relative badge, full date on hover
			const dueCell = row.createEl("td");
			if (task.due) {
				const days = moment(task.due).diff(moment(now), "days");
				const late = isOverdue(task, now);
				dueCell.createSpan({
					cls: `tt-due-badge${late ? " is-late" : !isClosed(task.status) && days <= 1 ? " is-soon" : ""}`,
					text: late ? `${-days}d late` : relativeDay(days, task.due),
					attr: { "aria-label": moment(task.due).format("dddd, MMM D, YYYY") },
				});
			} else {
				dueCell.createSpan({ cls: "tt-faint", text: "—" });
			}

			// Spent / estimate with a thin bar
			const timeCell = row.createEl("td", { cls: "tt-time-cell" });
			if (task.estimate || task.spent) {
				timeCell.createDiv({ cls: "tt-num", text: `${task.spent}${task.estimate ? ` / ${task.estimate}` : ""}h` });
				if (task.estimate) {
					const over = task.spent > task.estimate;
					const bar = timeCell.createDiv({ cls: "tt-time-bar" });
					bar.createDiv({ cls: `tt-time-fill${over ? " is-over" : ""}` }).setAttr(
						"style",
						`width: ${Math.min(100, Math.round((task.spent / task.estimate) * 100))}%`
					);
				}
			} else {
				timeCell.createSpan({ cls: "tt-faint", text: "—" });
			}

			// Actions in one row, shown on hover
			const actions = row.createEl("td", { cls: "tt-actions" });
			const group = actions.createDiv({ cls: "tt-actions-group" });
			if (!isClosed(task.status)) timerButton(group, this.plugin, task.file);
			const editBtn = group.createEl("button", { cls: "clickable-icon tt-edit-btn", attr: { "aria-label": "Edit task" } });
			setIcon(editBtn, "pencil");
			editBtn.addEventListener("click", () => this.plugin.openEditTaskModal(task));
			const del = group.createEl("button", { cls: "clickable-icon tt-delete-btn", attr: { "aria-label": "Delete task" } });
			setIcon(del, "trash-2");
			del.addEventListener("click", () => this.plugin.confirmDeleteTask(task.file));
		}
	}

	private filtered(tasks: Task[]): Task[] {
		const q = this.query.trim().toLowerCase();
		return tasks.filter((t) => {
			if (this.projectFilter !== "all" && t.project?.id !== this.projectFilter) return false;
			if (this.statusFilter === "open" && isClosed(t.status)) return false;
			if (this.statusFilter !== "open" && this.statusFilter !== "all" && t.status !== this.statusFilter) return false;
			if (this.priorityFilter !== "all" && t.priority !== this.priorityFilter) return false;
			if (q && ![t.title, t.project?.name ?? "", ...t.category].some((s) => s.toLowerCase().includes(q))) return false;
			return true;
		});
	}

	private sorted(tasks: Task[]): Task[] {
		const byTitle = (a: Task, b: Task) => a.title.localeCompare(b.title);
		const compare: Record<SortKey, (a: Task, b: Task) => number> = {
			// Tasks without a due date go last.
			due: (a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || byTitle(a, b),
			priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byTitle(a, b),
			created: (a, b) => (b.created ?? "").localeCompare(a.created ?? "") || byTitle(a, b),
			title: byTitle,
		};
		return [...tasks].sort(compare[this.sortKey]);
	}

	private save(p: Promise<void>): void {
		// The store's "changed" event re-renders the list once the note is saved.
		p.catch((e) => new Notice(`Task Tracker: ${e instanceof Error ? e.message : "save failed"}`));
	}
}

function relativeDay(days: number, date: string): string {
	if (days === 0) return "Today";
	if (days === 1) return "Tomorrow";
	if (days === -1) return "Yesterday";
	return moment(date).format("MMM D");
}

function select(
	parent: HTMLElement,
	options: [string, string][],
	value: string,
	onChange: (v: string) => void,
	cls = ""
): HTMLSelectElement {
	const el = parent.createEl("select", { cls: `dropdown ${cls}`.trim() });
	for (const [v, label] of options) el.createEl("option", { value: v, text: label });
	el.value = value;
	el.addEventListener("change", () => onChange(el.value));
	return el;
}
