import { MarkdownPostProcessorContext, MarkdownRenderChild, moment, Notice, setIcon } from "obsidian";
import { taskBadges } from "./badges";
import type TaskTrackerPlugin from "./main";
import { today } from "./store";
import { isBlocked, isClosed, PRIORITY_RANK, Project, STATUS_LABELS, Task, TaskStatus } from "./types";

/**
 * ```task-tracker
 * project: Study Docker   (optional — defaults to the note's own project, or all projects)
 * show: open | all        (optional, default open)
 * limit: 10               (optional, default 10)
 * ```
 * Renders a live progress bar + task list inside any note.
 */
export function registerCodeBlock(plugin: TaskTrackerPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor("task-tracker", (source, el, ctx) => {
		ctx.addChild(new TaskBlock(el, plugin, parseOptions(source), ctx));
	});
}

interface BlockOptions {
	project: string | null;
	show: "open" | "all";
	limit: number;
}

function parseOptions(source: string): BlockOptions {
	const opts: BlockOptions = { project: null, show: "open", limit: 10 };
	for (const line of source.split("\n")) {
		const m = line.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
		if (!m) continue;
		const [, key, value] = m;
		if (key === "project") opts.project = value.replace(/^\[\[|\]\]$/g, "");
		if (key === "show" && (value === "all" || value === "open")) opts.show = value;
		if (key === "limit" && Number(value) > 0) opts.limit = Math.floor(Number(value));
	}
	return opts;
}

const STACK_ORDER: TaskStatus[] = ["done", "failed", "in-progress", "todo"];
const STATUS_COLOR: Record<TaskStatus, string> = { todo: "#9ca3af", "in-progress": "#9b5de5", done: "#0d9488", failed: "#e5484d" };

/** Lives as long as the rendered block; re-renders when tasks change. */
class TaskBlock extends MarkdownRenderChild {
	constructor(
		el: HTMLElement,
		private plugin: TaskTrackerPlugin,
		private opts: BlockOptions,
		private ctx: MarkdownPostProcessorContext
	) {
		super(el);
	}

	onload(): void {
		this.registerEvent(this.plugin.store.on("changed", () => this.render()));
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
		el.addClass("tt-block");

		const project = this.project();
		if (project === "missing") {
			el.createDiv({ cls: "tt-block-empty", text: `Task Tracker: no project named "${this.opts.project}".` });
			return;
		}
		const tasks = this.plugin.store.getTasks().filter((t) => !project || t.project?.id === project.id);
		const done = tasks.filter((t) => t.status === "done").length;
		const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

		// Header: name + % + stacked status bar + counts
		const head = el.createDiv({ cls: "tt-block-head" });
		head.createSpan({ cls: "tt-block-title", text: project ? project.name : "All projects" });
		head.createSpan({ cls: "tt-block-pct", text: `${pct}% done` });
		const bar = el.createDiv({ cls: "tt-stackbar" });
		for (const s of STACK_ORDER) {
			const n = tasks.filter((t) => t.status === s).length;
			if (n) bar.createDiv({ cls: "tt-stackbar-seg" }).setAttr("style", `flex: ${n}; background: ${STATUS_COLOR[s]}`);
		}
		const counts = el.createDiv({ cls: "tt-legend" });
		for (const s of STACK_ORDER) {
			const item = counts.createSpan({ cls: "tt-legend-item" });
			item.createSpan({ cls: "tt-legend-dot" }).setAttr("style", `background: ${STATUS_COLOR[s]}`);
			item.appendText(`${STATUS_LABELS[s]} ${tasks.filter((t) => t.status === s).length}`);
		}

		// Task list
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

	private row(list: HTMLElement, t: Task, showProject: boolean): void {
		const row = list.createDiv({ cls: `tt-block-row${isBlocked(t) ? " is-blocked" : ""}${isClosed(t.status) ? " is-closed" : ""}` });
		const check = row.createEl("button", { cls: `tt-check${t.status === "done" ? " is-done" : ""}`, attr: { "aria-label": "Mark done" } });
		if (t.status === "done") setIcon(check, "check");
		check.disabled = isClosed(t.status);
		check.addEventListener("click", () =>
			this.plugin.store.setStatus(t.file, "done").catch((e) => new Notice(`Task Tracker: ${e instanceof Error ? e.message : "save failed"}`))
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
