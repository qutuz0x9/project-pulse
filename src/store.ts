import {
	App,
	debounce,
	Events,
	FrontMatterCache,
	moment,
	normalizePath,
	Notice,
	parseFrontMatterTags,
	TFile,
} from "obsidian";
import type { Moment } from "moment";
import { nextDue, parseRepeat } from "./recurrence";
import type { ProjectPulseSettings } from "./settings";
import {
	FM,
	isClosed,
	NewTaskInput,
	PRIORITIES,
	Project,
	STATUSES,
	Task,
	TaskPriority,
	TaskStatus,
} from "./types";

export const today = (): string => moment().format("YYYY-MM-DD");

/**
 * Reads projects and tasks straight from the vault's notes (no separate database),
 * writes task notes, and fires a "changed" event when anything task-related changes.
 */
export class TaskStore extends Events {
	private notifyChanged = debounce(() => this.trigger("changed"), 300, true);
	private spawning = new Set<string>(); // recurring tasks whose next copy is being created

	constructor(private app: App, private settings: ProjectPulseSettings) {
		super();
	}

	/** The tag that marks a note as a task, without a leading "#" (setting). */
	private taskTag(): string {
		return this.settings.taskTag.replace(/^#/, "");
	}

	// Called by the plugin on file create/edit/delete/rename.
	onFileChanged(file: TFile): void {
		if (file.extension !== "md") return;
		this.syncCompletedDate(file);
		this.spawnNextIfRecurring(file);
		this.notifyChanged();
	}

	// ---------- read ----------

	/** Every note that has a `tracker-project` property, wherever it lives in the vault. */
	getProjects(): Project[] {
		const projects: Project[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.settings.projectProperty];
			if (!value) continue;
			const name = typeof value === "string" && value.trim() ? value.trim() : file.basename;
			projects.push({ id: file.path, name, folder: file.parent?.path ?? "", file });
		}
		return projects.sort((a, b) => a.name.localeCompare(b.name));
	}

	getTasks(): Task[] {
		const projects = this.getProjects();
		const tasks: Task[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (fm && this.isTaskFrontmatter(fm)) tasks.push(this.toTask(file, fm, projects));
		}
		// Second pass: blockers point at other tasks, so they can only be resolved once all are read.
		const byPath = new Map(tasks.map((t) => [t.file.path, t]));
		for (const t of tasks) {
			t.blockers = t.blockedByPaths
				.map((p) => byPath.get(p))
				.filter((b): b is Task => !!b && !isClosed(b.status));
		}
		return tasks;
	}

	/** The project this note is (a project note) or belongs to (a task note), if any. */
	projectForFile(file: TFile): Project | null {
		const project = this.getProjects().find((p) => p.id === file.path);
		if (project) return project;
		return this.getTasks().find((t) => t.file.path === file.path)?.project ?? null;
	}

	isProject(file: TFile): boolean {
		return !!this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.settings.projectProperty];
	}

	isTask(file: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return !!fm && this.isTaskFrontmatter(fm);
	}

	private isTaskFrontmatter(fm: FrontMatterCache): boolean {
		return (parseFrontMatterTags(fm) ?? []).includes("#" + this.taskTag());
	}

	private toTask(file: TFile, fm: FrontMatterCache, projects: Project[]): Task {
		return {
			file,
			title: file.basename,
			project: this.resolveProject(file, fm[FM.project], projects),
			status: oneOf(fm[this.settings.statusProperty], STATUSES, "todo"),
			priority: oneOf(fm[FM.priority], PRIORITIES, "medium"),
			due: toDate(fm[FM.due]),
			created: toDate(fm[FM.created]),
			completed: toDate(fm[FM.completed]),
			estimate: toNumber(fm[FM.estimate]),
			spent: toNumber(fm[FM.spent]) ?? 0,
			pomodoros: toNumber(fm[FM.pomodoros]) ?? 0,
			category: toList(fm[FM.category]),
			checklist: this.checklist(file),
			repeat: parseRepeat(fm[FM.repeat]) ? String(fm[FM.repeat]).trim() : null,
			scheduled: toDateTime(fm[FM.scheduled]),
			scheduledEnd: toDateTime(fm[FM.scheduledEnd]),
			blockedByPaths: this.resolveLinks(file, fm[FM.blockedBy]),
			blockers: [],
		};
	}

	/** Counts `- [ ]` / `- [x]` checkboxes in the note body (Obsidian already indexes them). */
	private checklist(file: TFile): { done: number; total: number } | null {
		const items = (this.app.metadataCache.getFileCache(file)?.listItems ?? []).filter((i) => i.task !== undefined);
		if (items.length === 0) return null;
		return { done: items.filter((i) => i.task !== " ").length, total: items.length };
	}

	/** A list (or single value) of "[[links]]" → note paths that exist. */
	private resolveLinks(file: TFile, value: unknown): string[] {
		const list = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
		const paths: string[] = [];
		for (const v of list) {
			const linkpath = String(v).replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
			const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
			if (target) paths.push(target.path);
		}
		return paths;
	}

	private linkTo(path: string): string | null {
		const f = this.app.vault.getFileByPath(path);
		return f ? `[[${f.basename}]]` : null;
	}

	// `project` holds a link like "[[00- Food Delivery Clone - Overview]]" to the project note.
	private resolveProject(file: TFile, value: unknown, projects: Project[]): Project | null {
		if (typeof value !== "string") return null;
		const linkpath = value.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
		const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
		return (target && projects.find((p) => p.id === target.path)) ?? null;
	}

	// ---------- write ----------

	/** Creates <newProjectsFolder>/<name>/<name>.md as a project note. */
	async createProject(name: string): Promise<TFile> {
		const safe = safeFileName(name);
		if (!safe) throw new Error("Project name is required.");
		const folder = normalizePath(`${this.settings.newProjectsFolder}/${safe}`);
		const path = normalizePath(`${folder}/${safe}.md`);
		if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`A project named "${name}" already exists.`);
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);

		const file = await this.app.vault.create(path, "## Goal\n\n");
		await this.markAsProject(file, name.trim());
		return file;
	}

	async markAsProject(file: TFile, name: string): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[this.settings.projectProperty] = name;
		});
	}

	/** Removes the property only; its task notes stay untouched. */
	async unmarkProject(file: TFile): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			delete fm[this.settings.projectProperty];
		});
	}

	async createTask(input: NewTaskInput, body = "## Notes\n\n"): Promise<TFile> {
		const folder = normalizePath(`${input.project.folder}/${this.settings.tasksSubfolder}`);
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);

		const path = normalizePath(`${folder}/${safeFileName(input.title)}.md`);
		if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`A task named "${input.title}" already exists.`);

		const file = await this.app.vault.create(path, body);
		const projectLink = `[[${input.project.file.basename}]]`;
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm.tags = [this.taskTag()];
			fm[FM.project] = projectLink;
			fm[this.settings.statusProperty] = input.status;
			fm[FM.priority] = input.priority;
			fm[FM.due] = input.due ?? "";
			fm[FM.created] = today();
			fm[FM.completed] = isClosed(input.status) ? today() : "";
			fm[FM.estimate] = input.estimate ?? "";
			fm[FM.spent] = 0;
			fm[FM.category] = input.category;
			this.writeOptional(fm, input);
		});
		return file;
	}

	/**
	 * Saves every field from the edit form. A new title renames the note (Obsidian updates links),
	 * and a new project moves the note into that project's Tasks folder.
	 */
	async updateTask(task: Task, input: NewTaskInput): Promise<TFile> {
		const file = task.file;
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[FM.project] = `[[${input.project.file.basename}]]`;
			fm[this.settings.statusProperty] = input.status;
			fm[FM.completed] = isClosed(input.status) ? fm[FM.completed] || today() : "";
			fm[FM.priority] = input.priority;
			fm[FM.due] = input.due ?? "";
			fm[FM.estimate] = input.estimate ?? "";
			fm[FM.category] = input.category;
			this.writeOptional(fm, input);
		});

		const projectChanged = task.project?.id !== input.project.id;
		const folder = projectChanged
			? normalizePath(`${input.project.folder}/${this.settings.tasksSubfolder}`)
			: file.parent?.path ?? "";
		const newPath = normalizePath(`${folder}/${safeFileName(input.title)}.md`);
		if (newPath !== file.path) {
			if (this.app.vault.getAbstractFileByPath(newPath)) throw new Error(`A task named "${input.title}" already exists there.`);
			if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
			await this.app.fileManager.renameFile(file, newPath);
		}
		return file;
	}

	/** `repeat`, `blocked-by` and the schedule are only written when set, so plain tasks stay uncluttered. */
	private writeOptional(fm: Record<string, unknown>, input: NewTaskInput): void {
		if (input.scheduled !== undefined) {
			if (input.scheduled) fm[FM.scheduled] = input.scheduled;
			else delete fm[FM.scheduled];
		}
		if (input.scheduledEnd !== undefined) {
			if (input.scheduledEnd && input.scheduled) fm[FM.scheduledEnd] = input.scheduledEnd;
			else delete fm[FM.scheduledEnd];
		}
		if (input.repeat !== undefined) {
			if (input.repeat) fm[FM.repeat] = input.repeat;
			else delete fm[FM.repeat];
		}
		if (input.blockedBy !== undefined) {
			const links = input.blockedBy.map((p) => this.linkTo(p)).filter((l): l is string => !!l);
			if (links.length) fm[FM.blockedBy] = links;
			else delete fm[FM.blockedBy];
		}
	}

	/**
	 * When a recurring task is closed (done or failed) — by any route: board, list, form or editing
	 * the property — create the next copy once, and mark the old one with `next: [[copy]]`.
	 */
	private spawnNextIfRecurring(file: TFile): void {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || !this.isTaskFrontmatter(fm) || fm[FM.next] || this.spawning.has(file.path)) return;
		const rule = parseRepeat(fm[FM.repeat]);
		if (!rule || !isClosed(oneOf(fm[this.settings.statusProperty], STATUSES, "todo"))) return;

		const task = this.getTasks().find((t) => t.file.path === file.path);
		if (!task?.project) return; // a copy needs a project to live in

		this.spawning.add(file.path);
		(async () => {
			const due = nextDue(task.due ?? task.completed ?? today(), rule, today());
			const base = task.title.replace(/ \(\d{4}-\d{2}-\d{2}\)$/, "");
			// Same notes, checklist unticked.
			const body = (await this.app.vault.read(file)).replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/^(\s*[-*+] )\[[^\]]\]/gm, "$1[ ]");
			const copy = await this.createTask(
				{
					title: `${base} (${due})`,
					project: task.project as Project,
					status: "todo",
					priority: task.priority,
					due,
					estimate: task.estimate,
					category: task.category,
					repeat: task.repeat,
					blockedBy: [],
				},
				body || "## Notes\n\n"
			);
			await this.app.fileManager.processFrontMatter(file, (f) => {
				f[FM.next] = `[[${copy.basename}]]`;
			});
			new Notice(`Next "${base}" created for ${due}`);
		})()
			.catch((e) => console.error("Project Pulse: failed to create next recurring task", e))
			.finally(() => this.spawning.delete(file.path));
	}

	async setStatus(file: TFile, status: TaskStatus): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[this.settings.statusProperty] = status;
			fm[FM.completed] = isClosed(status) ? fm[FM.completed] || today() : "";
		});
	}

	/** Calendar drag/resize. `end` null removes the end (block uses estimate or 1h). */
	async setSchedule(file: TFile, start: string, end: string | null): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[FM.scheduled] = start;
			if (end) fm[FM.scheduledEnd] = end;
			else delete fm[FM.scheduledEnd];
		});
	}

	async setDue(file: TFile, due: string): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[FM.due] = due;
		});
	}

	async setPriority(file: TFile, priority: TaskPriority): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[FM.priority] = priority;
		});
	}

	/**
	 * Adds one timer session to `time-log` and its hours to `spent`.
	 * `countPomodoro` also adds 1 to `pomodoros` (a finished focus session).
	 */
	async addTimeEntry(file: TFile, start: Moment, end: Moment, countPomodoro = false): Promise<void> {
		const hours = end.diff(start, "minutes") / 60;
		const entry = `${start.format("YYYY-MM-DDTHH:mm")}/${end.format("YYYY-MM-DDTHH:mm")}`;
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			const log = Array.isArray(fm[FM.timeLog]) ? fm[FM.timeLog] : [];
			fm[FM.timeLog] = [...log, entry];
			fm[FM.spent] = Math.round(((toNumber(fm[FM.spent]) ?? 0) + hours) * 100) / 100;
			if (countPomodoro) fm[FM.pomodoros] = (toNumber(fm[FM.pomodoros]) ?? 0) + 1;
		});
	}

	// Keeps `completed` (closed date) correct when task-status is edited by hand in the note's properties.
	private syncCompletedDate(file: TFile): void {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || !this.isTaskFrontmatter(fm)) return;

		const closed = isClosed(oneOf(fm[this.settings.statusProperty], STATUSES, "todo"));
		const hasCompleted = !!toDate(fm[FM.completed]);
		if (closed !== hasCompleted) {
			this.app.fileManager
				.processFrontMatter(file, (f) => {
					f[FM.completed] = closed ? today() : "";
				})
				.catch((e) => console.error("Project Pulse: failed to update completed date", e));
		}
	}
}

// ---------- helpers ----------

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

function toDate(value: unknown): string | null {
	if (!value) return null;
	const m = moment(String(value), "YYYY-MM-DD", true);
	return m.isValid() ? m.format("YYYY-MM-DD") : null;
}

/** "2026-10-09" or "2026-10-09T14:00" (seconds/space also accepted) → normalized string, else null. */
function toDateTime(value: unknown): string | null {
	if (!value) return null;
	const v = String(value).trim().replace(" ", "T");
	if (moment(v, "YYYY-MM-DD", true).isValid()) return v;
	const m = moment(v, ["YYYY-MM-DDTHH:mm", "YYYY-MM-DDTHH:mm:ss"], true);
	return m.isValid() ? m.format("YYYY-MM-DDTHH:mm") : null;
}

function toNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function toList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	if (typeof value === "string" && value.trim()) return value.split(",").map((s) => s.trim()).filter(Boolean);
	return [];
}

// File names can't contain these characters on some systems / in Obsidian links.
function safeFileName(title: string): string {
	return title.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
}
