import { ItemView, moment, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { taskBadges } from "./badges";
import type ProjectPulsePlugin from "./main";
import { formatMinutes } from "./pomodoroStats";
import { today } from "./store";
import { isBlocked, isClosed, PRIORITY_LABELS, PRIORITY_RANK, Task } from "./types";

export const VIEW_TYPE_TODAY = "project-pulse-today";

const COMING_UP_DAYS = 3;
const WEEK_DAYS = 7;

type SortKey = "smart" | "due" | "priority" | "project" | "quick" | "title";
const SORT_LABELS: [SortKey, string][] = [
	["smart", "Sort: Smart"],
	["due", "Sort: Due date"],
	["priority", "Sort: Priority"],
	["project", "Sort: Project"],
	["quick", "Sort: Quick wins"],
	["title", "Sort: Title"],
];

/**
 * One page to start the day, top to bottom:
 * header → stat tiles → up next → today's schedule → week strip → toolbar → task sections.
 */
export class TodayView extends ItemView {
	private sortKey: SortKey = "smart";
	private projectFilter = "all";
	private hideBlocked = false;
	private selectedDay: string | null = null; // a day picked in the week strip
	private expanded = new Set<string>(); // task paths with their checklist open

	constructor(leaf: WorkspaceLeaf, private plugin: ProjectPulsePlugin) {
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
		// Re-render every few minutes so "now" in the schedule and "today" after midnight stay right.
		this.registerInterval(window.setInterval(() => this.render(), 5 * 60_000));
		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private render(): void {
		const root = this.contentEl;
		const scroll = root.scrollTop;
		root.empty();
		root.addClass("tt-view", "tt-dash", "tt-today");

		const now = today();
		const all = this.plugin.store
			.getTasks()
			.filter((t) => this.projectFilter === "all" || t.project?.id === this.projectFilter);
		const open = all.filter((t) => !isClosed(t.status));
		const doneToday = all.filter((t) => t.status === "done" && t.completed === now);
		const overdue = open.filter((t) => t.due !== null && t.due < now);
		const dueToday = open.filter((t) => t.due === now);

		this.renderHeader(root, overdue.length + dueToday.length, doneToday.length);
		this.renderStats(root, open, doneToday.length, overdue.length);
		this.renderUpNext(root, open);
		this.renderSchedule(root, all);
		this.renderWeek(root, open);
		this.renderToolbar(root);
		this.renderSections(root, open, doneToday);

		root.scrollTop = scroll; // re-renders (e.g. ticking a checklist item) keep your place
	}

	// ---------- header + stats ----------

	private renderHeader(root: HTMLElement, toFinish: number, done: number): void {
		const header = root.createDiv({ cls: "tt-dash-header" });
		const heading = header.createDiv({ cls: "tt-dash-heading" });
		heading.createDiv({ cls: "tt-dash-eyebrow", text: "Today" });
		heading.createEl("h2", { cls: "tt-dash-title", text: moment().format("dddd, MMM D") });
		heading.createDiv({
			cls: "tt-dash-sub",
			text: `${toFinish} to finish today · ${done} done · ${this.plugin.pomodoro.completedToday()} 🍅`,
		});
		const controls = header.createDiv({ cls: "tt-dash-controls" });
		const cal = controls.createEl("button", { text: "Calendar" });
		cal.addEventListener("click", () => this.plugin.openCalendarView());
		const pomo = controls.createEl("button", { text: "Pomodoro" });
		pomo.addEventListener("click", () => this.plugin.activatePomodoroView());
		const add = controls.createEl("button", { cls: "mod-cta", text: "Quick add" });
		add.addEventListener("click", () => this.plugin.openQuickAdd());
	}

	private renderStats(root: HTMLElement, open: Task[], doneCount: number, overdueCount: number): void {
		const now = today();
		// Planned = open work due or scheduled today (or overdue): remaining estimate, 1 h when unknown.
		const planned = open.filter((t) => (t.due !== null && t.due <= now) || t.scheduled?.slice(0, 10) === now);
		const unknown = planned.filter((t) => !t.estimate).length;
		const hours = round1(planned.reduce((a, t) => a + (t.estimate ? Math.max(0, t.estimate - t.spent) : 1), 0));
		const budget = this.plugin.settings.dailyBudget;
		const over = hours > budget;

		const focusMin = this.plugin.settings.pomodoroSessions
			.filter((s) => s.start.slice(0, 10) === now)
			.reduce((a, s) => a + s.minutes, 0);

		const row = root.createDiv({ cls: "tt-kpis tt-today-kpis" });
		const p = tile(row, "Planned today", `${hours}h`, over ? "220, 38, 38" : "155, 93, 229");
		const bar = p.createDiv({ cls: "tt-progress" });
		bar.createDiv({ cls: `tt-progress-fill${over ? " is-over" : ""}` }).setCssProps({ "--tt-pct": `${Math.min(100, (hours / budget) * 100)}%` });
		p.createDiv({
			cls: "tt-kpi-sub",
			text: `of ${budget}h budget${over ? " · too much — move something" : ""}${unknown ? ` · ${unknown} without estimate (1h each)` : ""}`,
		});
		tile(row, "Done today", `${doneCount}`, "13, 148, 136").createDiv({ cls: "tt-kpi-sub", text: doneCount ? "nice work" : "close one to start" });
		tile(row, "Focus today", formatMinutes(focusMin), "37, 99, 235").createDiv({
			cls: "tt-kpi-sub",
			text: `${this.plugin.pomodoro.completedToday()} 🍅 completed`,
		});
		tile(row, "Overdue", `${overdueCount}`, overdueCount ? "220, 38, 38" : "13, 148, 136").createDiv({
			cls: "tt-kpi-sub",
			text: overdueCount ? "deal with these first" : "nothing late",
		});
	}

	// ---------- up next ----------

	/** The single best thing to do now — never a blocked task. */
	private pickNext(open: Task[]): { task: Task; why: string } | null {
		const now = today();
		const nowTime = moment().format("YYYY-MM-DDTHH:mm");
		const free = open.filter((t) => !isBlocked(t));
		const byPrio = (a: Task, b: Task) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
		const pomo = this.plugin.pomodoro.state;

		const focusing = pomo.phase === "focus" ? free.find((t) => t.file.path === pomo.taskPath) : undefined;
		if (focusing) return { task: focusing, why: "You're focusing on this right now" };

		const scheduledNow = free.find((t) => t.scheduled?.includes("T") && t.scheduled <= nowTime && scheduledEnd(t) > nowTime);
		if (scheduledNow) return { task: scheduledNow, why: `Scheduled now · ${timeRange(scheduledNow)}` };

		const late = free.filter((t) => t.due !== null && t.due < now).sort((a, b) => byPrio(a, b) || (a.due ?? "").localeCompare(b.due ?? ""));
		if (late.length) {
			const days = moment(now).diff(moment(late[0].due), "days");
			return { task: late[0], why: `${days} day${days === 1 ? "" : "s"} overdue · ${PRIORITY_LABELS[late[0].priority].toLowerCase()} priority` };
		}

		const laterToday = free
			.filter((t) => t.scheduled?.startsWith(now) && t.scheduled.includes("T") && t.scheduled > nowTime)
			.sort((a, b) => (a.scheduled ?? "").localeCompare(b.scheduled ?? ""));
		const dueNow = free.filter((t) => t.due === now).sort(byPrio);
		if (dueNow.length) return { task: dueNow[0], why: `Due today · ${PRIORITY_LABELS[dueNow[0].priority].toLowerCase()} priority` };
		if (laterToday.length) return { task: laterToday[0], why: `Scheduled today · ${timeRange(laterToday[0])}` };

		const started = free.filter((t) => t.status === "in-progress").sort(byPrio);
		if (started.length) return { task: started[0], why: "Already in progress — finish it" };

		const next = free.filter((t) => t.due !== null).sort((a, b) => (a.due ?? "").localeCompare(b.due ?? "") || byPrio(a, b));
		if (next.length) return { task: next[0], why: `Next deadline · ${moment(next[0].due).format("ddd, MMM D")}` };
		return null;
	}

	private renderUpNext(root: HTMLElement, open: Task[]): void {
		const pick = this.pickNext(open);
		if (!pick) return;
		const { task, why } = pick;
		const card = root.createDiv({ cls: `tt-upnext tt-upnext-${task.priority}` });
		const text = card.createDiv({ cls: "tt-upnext-text" });
		text.createDiv({ cls: "tt-upnext-eyebrow", text: "Up next" });
		const title = text.createEl("a", { cls: "tt-upnext-title", text: task.title });
		title.addEventListener("click", () => this.openTask(task.file));
		const meta = text.createDiv({ cls: "tt-task-meta" });
		meta.createSpan({ cls: "tt-upnext-why", text: why });
		if (task.project) meta.createSpan({ cls: "tt-task-project", text: task.project.name });
		taskBadges(meta, task);

		const actions = card.createDiv({ cls: "tt-upnext-actions" });
		const pomo = this.plugin.pomodoro.state;
		const focusing = pomo.phase === "focus" && pomo.taskPath === task.file.path;
		const start = actions.createEl("button", { cls: "mod-cta", text: focusing ? "🍅 Focusing" : "🍅 Start focus" });
		start.addEventListener("click", () => (focusing ? this.plugin.activatePomodoroView() : this.plugin.startPomodoroFor(task.file)));
		const done = actions.createEl("button", { text: "✓ Done" });
		done.addEventListener("click", () => this.markDone(task));
		const openBtn = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Open note" } });
		setIcon(openBtn, "file-text");
		openBtn.addEventListener("click", () => this.openTask(task.file));
	}

	// ---------- schedule ----------

	private renderSchedule(root: HTMLElement, all: Task[]): void {
		const now = today();
		const nowTime = moment().format("YYYY-MM-DDTHH:mm");
		const blocks = all
			.filter((t) => t.scheduled !== null && (t.scheduled.slice(0, 10) === now || (!t.scheduled.includes("T") && t.scheduled <= now && (t.scheduledEnd ?? t.scheduled) >= now)))
			.sort((a, b) => Number(!!a.scheduled?.includes("T")) - Number(!!b.scheduled?.includes("T")) || (a.scheduled ?? "").localeCompare(b.scheduled ?? ""));

		this.sectionTitle(root, "Schedule today", blocks.length, "");
		const box = root.createDiv({ cls: "tt-agenda" });
		if (blocks.length === 0) {
			const empty = box.createDiv({ cls: "tt-agenda-empty" });
			empty.appendText("Nothing scheduled today. ");
			const link = empty.createEl("a", { text: "Open the calendar" });
			link.addEventListener("click", () => this.plugin.openCalendarView());
			empty.appendText(" and drag a task in, or run /auto-schedule.");
			return;
		}
		for (const t of blocks) {
			const timed = !!t.scheduled?.includes("T");
			const end = scheduledEnd(t);
			const state = isClosed(t.status) ? "is-closed" : !timed ? "" : end <= nowTime ? "is-past" : (t.scheduled ?? "") <= nowTime ? "is-now" : "";
			const row = box.createDiv({ cls: `tt-agenda-row ${state}`.trim() });
			row.createSpan({ cls: "tt-agenda-time", text: timed ? timeRange(t) : "All day" });
			row.createSpan({ cls: `tt-agenda-bar tt-prio-bg-${t.priority}` });
			const title = row.createEl("a", { cls: "tt-agenda-title", text: t.title });
			title.addEventListener("click", () => this.openTask(t.file));
			if (state === "is-now") row.createSpan({ cls: "tt-agenda-now", text: "Now" });
		}
	}

	// ---------- week strip ----------

	private renderWeek(root: HTMLElement, open: Task[]): void {
		const strip = root.createDiv({ cls: "tt-week" });
		const now = today();
		for (let i = 0; i < WEEK_DAYS; i++) {
			const d = moment().add(i, "days");
			const key = d.format("YYYY-MM-DD");
			const due = open.filter((t) => t.due === key);
			const late = i === 0 ? open.filter((t) => t.due !== null && t.due < now).length : 0;
			const hours = round1(due.reduce((a, t) => a + (t.estimate ? Math.max(0, t.estimate - t.spent) : 1), 0));
			const day = strip.createEl("button", {
				cls: `tt-week-day${this.selectedDay === key ? " is-selected" : ""}${i === 0 ? " is-today" : ""}${hours > this.plugin.settings.dailyBudget ? " is-heavy" : ""}`,
				attr: { "aria-label": `${due.length} due ${d.format("dddd")}${hours ? ` · ~${hours}h` : ""}` },
			});
			day.createDiv({ cls: "tt-week-name", text: i === 0 ? "Today" : i === 1 ? "Tmrw" : d.format("ddd") });
			day.createDiv({ cls: "tt-week-date", text: d.format("D") });
			const count = day.createDiv({ cls: "tt-week-count" });
			if (due.length) count.createSpan({ cls: "tt-week-pill", text: `${due.length}` });
			if (late) count.createSpan({ cls: "tt-week-pill is-late", text: `+${late}` });
			if (!due.length && !late) count.createSpan({ cls: "tt-week-none", text: "—" });
			day.addEventListener("click", () => {
				this.selectedDay = this.selectedDay === key ? null : key;
				this.render();
			});
		}
	}

	// ---------- toolbar + sections ----------

	private renderToolbar(root: HTMLElement): void {
		const bar = root.createDiv({ cls: "tt-filters tt-today-toolbar" });
		const proj = bar.createEl("select", { cls: "dropdown" });
		proj.createEl("option", { value: "all", text: "All projects" });
		for (const p of this.plugin.store.getProjects()) proj.createEl("option", { value: p.id, text: p.name });
		proj.value = this.projectFilter;
		proj.addEventListener("change", () => {
			this.projectFilter = proj.value;
			this.render();
		});

		const sort = bar.createEl("select", { cls: "dropdown" });
		for (const [k, label] of SORT_LABELS) sort.createEl("option", { value: k, text: label });
		sort.value = this.sortKey;
		sort.addEventListener("change", () => {
			this.sortKey = sort.value as SortKey;
			this.render();
		});

		const toggle = bar.createEl("label", { cls: "tt-cal-toggle" });
		const box = toggle.createEl("input", { type: "checkbox" });
		box.checked = this.hideBlocked;
		box.addEventListener("change", () => {
			this.hideBlocked = box.checked;
			this.render();
		});
		toggle.appendText("Hide blocked");
	}

	private renderSections(root: HTMLElement, open: Task[], doneToday: Task[]): void {
		const now = today();
		const soon = moment().add(COMING_UP_DAYS, "days").format("YYYY-MM-DD");
		const visible = open.filter((t) => !this.hideBlocked || !isBlocked(t));

		const overdue = visible.filter((t) => t.due !== null && t.due < now);
		const dueToday = visible.filter((t) => t.due === now);
		const inProgress = visible.filter((t) => t.status === "in-progress" && !(t.due !== null && t.due <= now));
		const comingUp = visible.filter((t) => t.status !== "in-progress" && t.due !== null && t.due > now && t.due <= soon);

		// A day picked in the week strip shows only that day (today = the normal view).
		if (this.selectedDay && this.selectedDay !== now) {
			const label = moment(this.selectedDay).format("dddd, MMM D");
			this.section(root, `Due ${label}`, visible.filter((t) => t.due === this.selectedDay), "is-selected", "Nothing due that day.");
			const back = root.createEl("a", { cls: "tt-block-link tt-today-back", text: "✕ Show all" });
			back.addEventListener("click", () => {
				this.selectedDay = null;
				this.render();
			});
			return;
		}
		if (!overdue.length && !dueToday.length && !inProgress.length && !comingUp.length && !doneToday.length) {
			root.createDiv({ cls: "tt-empty", text: "Nothing due and nothing in progress. Use Quick add to plan something." });
			return;
		}
		this.section(root, "Overdue", overdue, "is-late");
		this.section(root, "Due today", dueToday, "is-today");
		this.section(root, "In progress", inProgress, "is-progress");
		this.section(root, `Coming up · next ${COMING_UP_DAYS} days`, comingUp, "");
		this.section(root, "Done today", doneToday, "is-done");
	}

	private sectionTitle(root: HTMLElement, label: string, count: number, cls: string): void {
		const head = root.createDiv({ cls: `tt-section tt-today-section ${cls}`.trim() });
		head.createSpan({ text: label });
		head.createSpan({ cls: "tt-today-count", text: `${count}` });
	}

	private section(root: HTMLElement, label: string, tasks: Task[], cls: string, emptyText = ""): void {
		if (tasks.length === 0 && !emptyText) return;
		this.sectionTitle(root, label, tasks.length, cls);
		const list = root.createDiv({ cls: "tt-today-list" });
		if (tasks.length === 0) list.createDiv({ cls: "tt-agenda-empty", text: emptyText });
		for (const t of this.sorted(tasks)) this.row(list, t);
	}

	private sorted(tasks: Task[]): Task[] {
		const byDue = (a: Task, b: Task) => (a.due ?? "9999").localeCompare(b.due ?? "9999");
		const byPrio = (a: Task, b: Task) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
		const byTitle = (a: Task, b: Task) => a.title.localeCompare(b.title);
		const blockedLast = (a: Task, b: Task) => Number(isBlocked(a)) - Number(isBlocked(b));
		const remaining = (t: Task) => (t.estimate ? Math.max(0, t.estimate - t.spent) : Infinity);
		const compare: Record<SortKey, (a: Task, b: Task) => number> = {
			// Smart: what can be done first, then the nearest date, then the most important.
			smart: (a, b) => blockedLast(a, b) || byDue(a, b) || byPrio(a, b) || byTitle(a, b),
			due: (a, b) => byDue(a, b) || byPrio(a, b) || byTitle(a, b),
			priority: (a, b) => byPrio(a, b) || byDue(a, b) || byTitle(a, b),
			project: (a, b) => (a.project?.name ?? "~").localeCompare(b.project?.name ?? "~") || byDue(a, b) || byPrio(a, b),
			quick: (a, b) => blockedLast(a, b) || remaining(a) - remaining(b) || byDue(a, b),
			title: byTitle,
		};
		return [...tasks].sort(compare[this.sortKey]);
	}

	private row(list: HTMLElement, task: Task): void {
		const now = today();
		const wrap = list.createDiv({ cls: "tt-today-item" });
		const row = wrap.createDiv({ cls: `tt-today-row${isBlocked(task) ? " is-blocked" : ""}${isClosed(task.status) ? " is-closed" : ""}` });

		const check = row.createEl("button", {
			cls: `tt-check${task.status === "done" ? " is-done" : ""}`,
			attr: { "aria-label": task.status === "done" ? "Done" : "Mark done" },
		});
		if (task.status === "done") setIcon(check, "check");
		check.disabled = isClosed(task.status);
		check.addEventListener("click", () => this.markDone(task));

		row.createSpan({ cls: `tt-dot tt-prio-dot-${task.priority}`, attr: { "aria-label": `${PRIORITY_LABELS[task.priority]} priority` } });

		const text = row.createDiv({ cls: "tt-today-text" });
		const title = text.createEl("a", { cls: "tt-title", text: task.title });
		title.addEventListener("click", () => this.openTask(task.file));
		const meta = text.createDiv({ cls: "tt-task-meta" });
		if (task.project) meta.createSpan({ cls: "tt-task-project", text: task.project.name });
		if (task.status === "in-progress") meta.createSpan({ cls: "tt-badge-mini is-progress", text: "In progress" });
		taskBadges(meta, task);
		if (task.estimate) meta.createSpan({ cls: "tt-badge-mini", text: `⏱ ${round1(Math.max(0, task.estimate - task.spent))}h left` });
		if (task.scheduled?.startsWith(now) && task.scheduled.includes("T")) {
			meta.createSpan({ cls: "tt-badge-mini is-progress", text: `🗓 ${timeRange(task)}` });
		}

		// The ☑ checklist badge expands the steps inline.
		const checklistBadge = meta.querySelector(".tt-checklist");
		if (checklistBadge) {
			checklistBadge.addClass("is-clickable");
			checklistBadge.setAttr("aria-label", this.expanded.has(task.file.path) ? "Hide steps" : "Show steps");
			checklistBadge.addEventListener("click", () => {
				if (this.expanded.has(task.file.path)) this.expanded.delete(task.file.path);
				else this.expanded.add(task.file.path);
				this.render();
			});
		}

		if (task.due && !isClosed(task.status)) {
			const days = moment(task.due).diff(moment(now), "days");
			row.createSpan({
				cls: `tt-due-badge${days < 0 ? " is-late" : days <= 1 ? " is-soon" : ""}`,
				text: days < 0 ? `${-days}d late` : days === 0 ? "Today" : days === 1 ? "Tomorrow" : moment(task.due).format("ddd"),
				attr: { "aria-label": moment(task.due).format("dddd, MMM D") },
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

		if (this.expanded.has(task.file.path)) this.renderChecklist(wrap, task);
	}

	// ---------- inline checklist ----------

	/** Lists the note's `- [ ]` steps; ticking one rewrites just that line in the note. */
	private renderChecklist(wrap: HTMLElement, task: Task): void {
		const box = wrap.createDiv({ cls: "tt-steps" });
		const items = (this.app.metadataCache.getFileCache(task.file)?.listItems ?? []).filter((i) => i.task !== undefined);
		this.app.vault.cachedRead(task.file).then((content) => {
			const lines = content.split("\n");
			for (const item of items) {
				const lineNo = item.position.start.line;
				const raw = lines[lineNo] ?? "";
				const label = raw.replace(/^\s*[-*+]\s+\[[^\]]\]\s*/, "");
				const step = box.createEl("label", { cls: `tt-step${item.task !== " " ? " is-done" : ""}` });
				const cb = step.createEl("input", { type: "checkbox" });
				cb.checked = item.task !== " ";
				cb.addEventListener("change", () => this.toggleStep(task.file, lineNo, cb.checked));
				step.createSpan({ text: label.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_m, target, _a, alias) => alias ?? target) });
			}
			if (!items.length) box.createDiv({ cls: "tt-agenda-empty", text: "No checklist steps in this note." });
		});
	}

	private toggleStep(file: TFile, lineNo: number, done: boolean): void {
		this.app.vault
			.process(file, (data) => {
				const lines = data.split("\n");
				const line = lines[lineNo];
				if (line !== undefined) lines[lineNo] = line.replace(/^(\s*[-*+]\s+)\[[^\]]\]/, `$1[${done ? "x" : " "}]`);
				return lines.join("\n");
			})
			.catch((e) => new Notice(`Project Pulse: ${e instanceof Error ? e.message : "save failed"}`));
	}

	// ---------- helpers ----------

	private markDone(task: Task): void {
		this.plugin.store.setStatus(task.file, "done").catch((e) => new Notice(`Project Pulse: ${e instanceof Error ? e.message : "save failed"}`));
	}

	private openTask(file: TFile): void {
		this.app.workspace.getLeaf(false).openFile(file);
	}
}

function tile(parent: HTMLElement, label: string, value: string, accent: string): HTMLElement {
	const t = parent.createDiv({ cls: "tt-kpi" });
	t.setCssProps({ "--c": accent });
	t.createDiv({ cls: "tt-kpi-label", text: label });
	t.createDiv({ cls: "tt-kpi-value", text: value });
	return t;
}

/** End of a timed block: `scheduled-end`, or start + estimate (1 h if none). */
function scheduledEnd(t: Task): string {
	if (t.scheduledEnd?.includes("T")) return t.scheduledEnd;
	return moment(t.scheduled).add(t.estimate ?? 1, "hours").format("YYYY-MM-DDTHH:mm");
}

function timeRange(t: Task): string {
	return `${moment(t.scheduled).format("HH:mm")}–${moment(scheduledEnd(t)).format("HH:mm")}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
