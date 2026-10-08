import { ItemView, moment, setIcon, WorkspaceLeaf } from "obsidian";
import { taskBadges } from "./badges";
import { TaskSuggestModal } from "./TaskSuggestModal";
import type TaskTrackerPlugin from "./main";
import { formatClock } from "./pomodoro";
import { today } from "./store";
import { isClosed, PRIORITY_LABELS, PRIORITY_RANK, Task } from "./types";

export const VIEW_TYPE_POMODORO = "task-tracker-pomodoro";

const RING_R = 92;
const RING_C = 2 * Math.PI * RING_R; // circumference, for the progress stroke

/**
 * Right-sidebar Pomodoro panel, top to bottom:
 * status header → ring with clock and ±1m → change/clear task → task card → main button → today's totals.
 */
export class PomodoroView extends ItemView {
	// Updated every second without re-rendering the whole panel.
	private clockEl: HTMLElement | null = null;
	private ringEl: SVGCircleElement | null = null;
	private detailEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: TaskTrackerPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_POMODORO;
	}

	getDisplayText(): string {
		return "Pomodoro";
	}

	getIcon(): string {
		return "timer";
	}

	async onOpen(): Promise<void> {
		this.registerEvent(this.plugin.store.on("changed", () => this.render()));
		this.registerEvent(this.plugin.pomodoro.on("changed", () => this.render()));
		this.registerEvent(this.plugin.pomodoro.on("tick", () => this.updateClock()));
		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("tt-pomo");

		const pomo = this.plugin.pomodoro;
		const state = pomo.state;
		const task = this.plugin.store.getTasks().find((t) => t.file.path === state.taskPath) ?? null;
		const inFocus = state.phase === "focus";
		const phaseCls = inFocus ? "is-focus" : state.phase === "idle" ? "is-idle" : "is-break";
		root.removeClass("is-focus", "is-idle", "is-break");
		root.addClass(phaseCls);

		// --- status header ---
		const head = root.createDiv({ cls: "tt-pomo-head" });
		head.createDiv({ cls: "tt-pomo-status", text: this.statusText() });
		this.detailEl = head.createDiv({ cls: "tt-pomo-detail" });

		// --- ring with clock and ±1m ---
		const ring = root.createDiv({ cls: `tt-pomo-ring${pomo.isPaused() ? " is-paused" : ""}` });
		const svg = ring.createSvg("svg", { attr: { viewBox: "0 0 200 200", "aria-hidden": "true" } });
		svg.createSvg("circle", { cls: "tt-pomo-track", attr: { cx: 100, cy: 100, r: RING_R } });
		this.ringEl = svg.createSvg("circle", {
			cls: "tt-pomo-progress",
			attr: { cx: 100, cy: 100, r: RING_R, "stroke-dasharray": RING_C, transform: "rotate(-90 100 100)" },
		});
		const center = ring.createDiv({ cls: "tt-pomo-center" });
		this.clockEl = center.createDiv({ cls: "tt-pomo-clock" });
		const adjust = center.createDiv({ cls: "tt-pomo-adjust" });
		for (const [label, delta] of [["-1m", -60_000], ["+1m", 60_000]] as const) {
			const b = adjust.createEl("button", { cls: "tt-pomo-adjust-btn", text: label });
			b.setAttr("aria-label", delta < 0 ? "One minute less" : "One minute more");
			b.addEventListener("click", () => pomo.adjust(delta));
		}

		// --- change / clear task ---
		const links = root.createDiv({ cls: "tt-pomo-links" });
		const change = links.createEl("button", { cls: "tt-pomo-link", text: task ? "Change task…" : "Choose a task…" });
		change.disabled = inFocus;
		change.addEventListener("click", () =>
			new TaskSuggestModal(this.app, this.openTasks(), (t) => pomo.selectTask(t.file.path)).open()
		);
		if (task) {
			const clear = links.createEl("button", { cls: "tt-pomo-link", text: "Clear task" });
			clear.disabled = inFocus;
			clear.addEventListener("click", () => pomo.selectTask(null));
		}
		if (inFocus) links.createDiv({ cls: "tt-pomo-hint", text: "Stop the session to switch task." });

		// --- task card ---
		if (task) this.renderTaskCard(root, task);

		// --- main button + secondary link ---
		const actions = root.createDiv({ cls: "tt-pomo-actions" });
		const main = actions.createEl("button", { cls: "mod-cta tt-pomo-main" });
		const secondary = (text: string, onClick: () => void) => {
			const b = actions.createEl("button", { cls: "tt-pomo-link tt-pomo-secondary", text });
			b.addEventListener("click", onClick);
		};
		if (state.phase === "idle") {
			main.setText("Start focus");
			main.disabled = !task;
			main.addEventListener("click", () => pomo.startFocus());
		} else if (pomo.isPaused()) {
			main.setText("Resume");
			main.addEventListener("click", () => pomo.resume());
			secondary(inFocus ? "Stop session" : "End break", () => pomo.stop());
		} else if (inFocus) {
			main.setText("Pause");
			main.addEventListener("click", () => pomo.pause());
			secondary("Stop session", () => pomo.stop());
		} else {
			main.setText("Skip break");
			main.addEventListener("click", () => pomo.skipBreak());
		}

		// --- today (click → statistics) ---
		const today = root.createEl("button", { cls: "tt-pomo-today", attr: { "aria-label": "Open Pomodoro statistics" } });
		today.createSpan({ cls: "tt-pomo-today-num", text: `${pomo.completedToday()}` });
		today.createSpan({ text: "completed today" });
		today.addEventListener("click", () => this.plugin.openPomodoroStats());

		this.updateClock();
	}

	private renderTaskCard(root: HTMLElement, task: Task): void {
		const card = root.createDiv({ cls: "tt-pomo-card" });

		const check = card.createEl("button", {
			cls: `tt-pomo-check${task.status === "done" ? " is-done" : ""}`,
			attr: { "aria-label": "Mark task done" },
		});
		if (task.status === "done") setIcon(check, "check");
		check.disabled = isClosed(task.status);
		check.addEventListener("click", () => this.plugin.pomodoro.completeTask());

		card.createSpan({
			cls: `tt-dot tt-prio-dot-${task.priority}`,
			attr: { "aria-label": `${PRIORITY_LABELS[task.priority]} priority` },
		});

		const body = card.createDiv({ cls: "tt-pomo-card-body" });
		const title = body.createDiv({ cls: "tt-pomo-card-title", text: task.title });
		title.addEventListener("click", () => this.openTask(task));

		const meta = body.createDiv({ cls: "tt-pomo-card-meta" });
		if (task.due) meta.createSpan({ cls: task.due < today() && !isClosed(task.status) ? "tt-overdue" : "", text: `Due: ${dueText(task.due)}` });
		if (task.project) meta.createSpan({ cls: "tt-pomo-card-project", text: task.project.name });
		meta.createSpan({ text: `🍅 ${task.pomodoros} · ${task.spent}${task.estimate ? `/${task.estimate}` : ""}h` });
		taskBadges(meta, task);

		if (task.category.length) {
			const chips = body.createDiv({ cls: "tt-pomo-card-chips" });
			for (const c of task.category) chips.createSpan({ cls: "tt-chip", text: c });
		}

		const open = card.createEl("button", { cls: "clickable-icon tt-pomo-open", attr: { "aria-label": "Open note" } });
		setIcon(open, "file-text");
		open.addEventListener("click", () => this.openTask(task));
	}

	private statusText(): string {
		const pomo = this.plugin.pomodoro;
		const phase = pomo.state.phase;
		if (pomo.isPaused()) return "Paused";
		if (phase === "focus") return "Focusing";
		if (phase === "short-break") return "Short break";
		if (phase === "long-break") return "Long break";
		return "Ready to start";
	}

	private detailText(): string {
		const pomo = this.plugin.pomodoro;
		const s = pomo.state;
		const every = this.plugin.settings.pomodoroLongEvery;
		const session = `Session ${(s.round % every) + 1} of ${every}`;
		const endsAt = moment(Date.now() + pomo.remainingMs()).format("HH:mm");
		if (s.phase === "idle") return `${session} · ${formatClock(pomo.totalMs())} planned`;
		if (pomo.isPaused()) return `${formatClock(pomo.remainingMs())} left`;
		if (s.phase === "focus") return `${session} · ends ${endsAt}`;
		return `Back to focus at ${endsAt}`;
	}

	private updateClock(): void {
		if (!this.clockEl || !this.ringEl) return;
		const pomo = this.plugin.pomodoro;
		const remaining = pomo.remainingMs();
		this.clockEl.setText(formatClock(remaining));
		this.detailEl?.setText(this.detailText());
		const done = pomo.state.phase === "idle" ? 0 : 1 - remaining / pomo.totalMs();
		this.ringEl.setAttr("stroke-dashoffset", String(RING_C * (1 - Math.min(1, Math.max(0, done)))));
	}

	private openTasks(): Task[] {
		return this.plugin.store
			.getTasks()
			.filter((t) => !isClosed(t.status))
			.sort(
				(a, b) =>
					(a.status === "in-progress" ? 0 : 1) - (b.status === "in-progress" ? 0 : 1) ||
					PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
					a.title.localeCompare(b.title)
			);
	}

	private openTask(task: Task): void {
		this.app.workspace.getLeaf(false).openFile(task.file);
	}
}

function dueText(due: string): string {
	const days = moment(due).diff(moment(today()), "days");
	if (days === 0) return "Today";
	if (days === 1) return "Tomorrow";
	if (days === -1) return "Yesterday";
	return moment(due).format("MMM D");
}
