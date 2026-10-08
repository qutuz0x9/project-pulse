import { ItemView, moment, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { isOverdue } from "./analytics";
import type ProjectPulsePlugin from "./main";
import { taskBadges } from "./badges";
import { timerButton } from "./timer";
import { today } from "./store";
import {
	isBlocked,
	isClosed,
	PRIORITIES,
	PRIORITY_LABELS,
	PRIORITY_RANK,
	STATUSES,
	STATUS_LABELS,
	Task,
	TaskPriority,
	TaskStatus,
} from "./types";

export const VIEW_TYPE_TASK_LIST = "project-pulse-list";

type StatusFilter = "all" | "open" | TaskStatus;
type SortKey = "due" | "priority" | "status" | "time" | "created" | "title";
type GroupKey = "none" | "project" | "status" | "priority" | "due";

const SORT_LABELS: [SortKey, string][] = [
	["due", "Sort: Due date"],
	["priority", "Sort: Priority"],
	["status", "Sort: Status"],
	["time", "Sort: Time left"],
	["created", "Sort: Newest"],
	["title", "Sort: Title"],
];
const GROUP_LABELS: [GroupKey, string][] = [
	["none", "Group: None"],
	["due", "Group: Due"],
	["project", "Group: Project"],
	["status", "Group: Status"],
	["priority", "Group: Priority"],
];
// Clickable column headers → the sort they apply.
const COLUMNS: [string, SortKey | null][] = [
	["Task", "title"],
	["Status", "status"],
	["Priority", "priority"],
	["Due", "due"],
	["Time", "time"],
	["", null],
];

/**
 * Layout: header (title + stat chips + search + New task) → filter row → table (optionally grouped).
 * Typing in search only redraws the table, so the input keeps focus.
 */
export class TaskListView extends ItemView {
	// Filters live only while the tab is open.
	private projectFilter = "all"; // "all" or a project id
	private statusFilter: StatusFilter = "open";
	private priorityFilter: "all" | TaskPriority = "all";
	private categoryFilter = "all";
	private sortKey: SortKey = "due";
	private sortDesc = false;
	private groupKey: GroupKey = "none";
	private collapsed = new Set<string>(); // group keys folded closed
	private query = "";
	private bodyEl: HTMLElement | null = null;
	private subEl: HTMLElement | null = null;
	private sortSelect: HTMLSelectElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: ProjectPulsePlugin) {
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
		const allTasks = this.plugin.store.getTasks();
		if (!projects.some((p) => p.id === this.projectFilter)) this.projectFilter = "all";
		const categories = [...new Set(allTasks.flatMap((t) => t.category))].sort();
		if (!categories.includes(this.categoryFilter)) this.categoryFilter = "all";

		// Header
		const header = root.createDiv({ cls: "tt-dash-header" });
		const heading = header.createDiv({ cls: "tt-dash-heading" });
		heading.createDiv({ cls: "tt-dash-eyebrow", text: "Tasks" });
		heading.createEl("h2", { cls: "tt-dash-title", text: "Task list" });
		this.subEl = heading.createDiv({ cls: "tt-list-chips" });

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

		// Filters, then (pushed right) group + sort
		const filters = root.createDiv({ cls: "tt-filters" });
		select(filters, [["all", "All projects"], ...projects.map((p): [string, string] => [p.id, p.name])], this.projectFilter, (v) => (this.projectFilter = v));
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
		if (categories.length) {
			select(filters, [["all", "All categories"], ...categories.map((c): [string, string] => [c, `#${c}`])], this.categoryFilter, (v) => (this.categoryFilter = v));
		}
		const spacer = filters.createDiv({ cls: "tt-filters-spacer" });
		spacer.setAttr("aria-hidden", "true");
		select(filters, GROUP_LABELS, this.groupKey, (v) => {
			this.groupKey = v as GroupKey;
			this.collapsed.clear();
		});
		this.sortSelect = select(filters, SORT_LABELS, this.sortKey, (v) => {
			this.sortKey = v as SortKey;
			this.sortDesc = false;
		});
		filters.querySelectorAll("select").forEach((el) => el.addEventListener("change", () => this.renderBody()));

		this.bodyEl = root.createDiv();
		this.renderBody();
	}

	/** Header chips + table (everything that depends on filters and search). */
	private renderBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();
		if (this.sortSelect) this.sortSelect.value = this.sortKey;

		const tasks = this.sorted(this.filtered(this.plugin.store.getTasks()));
		const now = today();
		this.renderChips(tasks, now);

		if (tasks.length === 0) {
			body.createDiv({
				cls: "tt-empty",
				text: this.query ? `No tasks match "${this.query}".` : "No tasks match these filters.",
			});
			return;
		}
		this.renderTable(body, tasks, now);
	}

	/** "10 open · 1 overdue · 5 blocked · 40h left" under the title. */
	private renderChips(tasks: Task[], now: string): void {
		const el = this.subEl;
		if (!el) return;
		el.empty();
		const open = tasks.filter((t) => !isClosed(t.status));
		const overdue = tasks.filter((t) => isOverdue(t, now)).length;
		const blocked = open.filter(isBlocked).length;
		const left = round1(open.reduce((a, t) => a + (t.estimate ? Math.max(0, t.estimate - t.spent) : 0), 0));
		const chip = (text: string, cls = "") => el.createSpan({ cls: `tt-list-chip ${cls}`.trim(), text });
		chip(`${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
		if (open.length !== tasks.length) chip(`${open.length} open`);
		if (overdue) chip(`${overdue} overdue`, "is-late");
		if (blocked) chip(`🔒 ${blocked} blocked`, "is-blocked");
		if (left) chip(`⏱ ${left}h left`);
	}

	private renderTable(parent: HTMLElement, tasks: Task[], now: string): void {
		const table = parent.createDiv({ cls: "tt-table-wrap" }).createEl("table", { cls: "tt-table" });
		const head = table.createEl("thead").createEl("tr");
		head.createEl("th", { cls: "tt-col-check" });
		for (const [label, key] of COLUMNS) {
			const th = head.createEl("th");
			if (!key) continue;
			const active = this.sortKey === key;
			const btn = th.createEl("button", { cls: `tt-th-sort${active ? " is-active" : ""}`, text: label });
			if (active) btn.createSpan({ cls: "tt-th-arrow", text: this.sortDesc ? "▼" : "▲" });
			btn.setAttr("aria-label", `Sort by ${label.toLowerCase()}`);
			btn.addEventListener("click", () => {
				if (this.sortKey === key) this.sortDesc = !this.sortDesc;
				else {
					this.sortKey = key;
					this.sortDesc = false;
				}
				this.renderBody();
			});
		}

		const tbody = table.createEl("tbody");
		const cols = COLUMNS.length + 1;
		for (const [key, label, list] of this.grouped(tasks, now)) {
			if (key !== null) {
				const folded = this.collapsed.has(key);
				const tr = tbody.createEl("tr", { cls: `tt-group-row${folded ? " is-collapsed" : ""}` });
				const td = tr.createEl("td", { attr: { colspan: String(cols) } });
				const toggle = td.createEl("button", { cls: "tt-group-toggle" });
				toggle.createSpan({ cls: "tt-group-caret", text: folded ? "▸" : "▾" });
				toggle.createSpan({ cls: "tt-group-label", text: label });
				toggle.createSpan({ cls: "tt-group-count", text: `${list.length}` });
				toggle.addEventListener("click", () => {
					if (folded) this.collapsed.delete(key);
					else this.collapsed.add(key);
					this.renderBody();
				});
				if (folded) continue;
			}
			for (const task of list) this.renderRow(tbody, task, now);
		}
	}

	private renderRow(tbody: HTMLElement, task: Task, now: string): void {
		const showProject = this.projectFilter === "all" && this.groupKey !== "project";
		const row = tbody.createEl("tr", { cls: `tt-row tt-status-${task.status}${isBlocked(task) ? " is-blocked" : ""}` });
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

		// Title + project + badges + categories
		const cell = row.createEl("td", { cls: "tt-task-cell" });
		const link = cell.createEl("a", { cls: "tt-title", text: task.title });
		link.addEventListener("click", () => this.app.workspace.getLeaf(false).openFile(task.file));
		const meta = cell.createDiv({ cls: "tt-task-meta" });
		if (showProject && task.project) meta.createSpan({ cls: "tt-task-project", text: task.project.name });
		taskBadges(meta, task);
		for (const c of task.category) meta.createSpan({ cls: "tt-chip", text: c });
		if (!meta.hasChildNodes()) meta.remove();

		// Status / priority: quiet pills that are still dropdowns (arrow shows on hover)
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

		// Time: just the estimate until time is logged, then spent / estimate with a bar
		const timeCell = row.createEl("td", { cls: "tt-time-cell" });
		if (task.spent > 0) {
			timeCell.createDiv({ cls: "tt-num", text: `${task.spent}${task.estimate ? ` / ${task.estimate}` : ""}h` });
			if (task.estimate) {
				const over = task.spent > task.estimate;
				timeCell
					.createDiv({ cls: "tt-time-bar" })
					.createDiv({ cls: `tt-time-fill${over ? " is-over" : ""}` })
					.setAttr("style", `width: ${Math.min(100, Math.round((task.spent / task.estimate) * 100))}%`);
			}
		} else if (task.estimate) {
			timeCell.createSpan({ cls: "tt-num tt-muted", text: `${task.estimate}h`, attr: { "aria-label": "Estimate — no time logged yet" } });
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

	/** [groupKey, label, tasks] in display order; a single [null, "", all] when not grouping. Keeps the sort inside each group. */
	private grouped(tasks: Task[], now: string): [string | null, string, Task[]][] {
		if (this.groupKey === "none") return [[null, "", tasks]];
		const weekEnd = moment().add(7, "days").format("YYYY-MM-DD"); // rolling, so "Sunday" isn't "later" on a Friday
		const keyOf = (t: Task): [string, string, number] => {
			switch (this.groupKey) {
				case "project":
					return [t.project?.id ?? "~", t.project?.name ?? "No project", t.project ? 0 : 1];
				case "status":
					return [t.status, STATUS_LABELS[t.status], STATUSES.indexOf(t.status)];
				case "priority":
					return [t.priority, `${PRIORITY_LABELS[t.priority]} priority`, PRIORITY_RANK[t.priority]];
				default: {
					if (!t.due) return ["none", "No due date", 5];
					if (!isClosed(t.status) && t.due < now) return ["late", "Overdue", 0];
					if (t.due === now) return ["today", "Today", 1];
					if (t.due <= weekEnd) return ["week", "Next 7 days", 2];
					return ["later", "Later", 3];
				}
			}
		};
		const groups = new Map<string, { label: string; order: number; list: Task[] }>();
		for (const t of tasks) {
			const [key, label, order] = keyOf(t);
			const g = groups.get(key) ?? { label, order, list: [] };
			g.list.push(t);
			groups.set(key, g);
		}
		return [...groups]
			.sort((a, b) => a[1].order - b[1].order || a[1].label.localeCompare(b[1].label))
			.map(([key, g]) => [key, g.label, g.list]);
	}

	private filtered(tasks: Task[]): Task[] {
		const q = this.query.trim().toLowerCase();
		return tasks.filter((t) => {
			if (this.projectFilter !== "all" && t.project?.id !== this.projectFilter) return false;
			if (this.statusFilter === "open" && isClosed(t.status)) return false;
			if (this.statusFilter !== "open" && this.statusFilter !== "all" && t.status !== this.statusFilter) return false;
			if (this.priorityFilter !== "all" && t.priority !== this.priorityFilter) return false;
			if (this.categoryFilter !== "all" && !t.category.includes(this.categoryFilter)) return false;
			if (q && ![t.title, t.project?.name ?? "", ...t.category].some((s) => s.toLowerCase().includes(q))) return false;
			return true;
		});
	}

	private sorted(tasks: Task[]): Task[] {
		const byTitle = (a: Task, b: Task) => a.title.localeCompare(b.title);
		const left = (t: Task) => (t.estimate ? Math.max(0, t.estimate - t.spent) : -1); // no estimate sorts first ascending
		const compare: Record<SortKey, (a: Task, b: Task) => number> = {
			// Tasks without a due date go last.
			due: (a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || byTitle(a, b),
			priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byTitle(a, b),
			status: (a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || byTitle(a, b),
			time: (a, b) => left(a) - left(b) || byTitle(a, b),
			created: (a, b) => (b.created ?? "").localeCompare(a.created ?? "") || byTitle(a, b),
			title: byTitle,
		};
		const sorted = [...tasks].sort(compare[this.sortKey]);
		return this.sortDesc ? sorted.reverse() : sorted;
	}

	private save(p: Promise<void>): void {
		// The store's "changed" event re-renders the list once the note is saved.
		p.catch((e) => new Notice(`Project Pulse: ${e instanceof Error ? e.message : "save failed"}`));
	}
}

function relativeDay(days: number, date: string): string {
	if (days === 0) return "Today";
	if (days === 1) return "Tomorrow";
	if (days === -1) return "Yesterday";
	if (days > 1 && days < 7) return moment(date).format("ddd");
	return moment(date).format("MMM D");
}

const round1 = (n: number) => Math.round(n * 10) / 10;

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
