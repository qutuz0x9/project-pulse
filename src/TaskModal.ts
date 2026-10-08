import { App, Modal, Notice, setIcon, Setting, TFile } from "obsidian";
import { REPEAT_OPTIONS } from "./recurrence";
import type { TaskStore } from "./store";
import { TaskSuggestModal } from "./TaskSuggestModal";
import {
	NewTaskInput,
	PRIORITIES,
	PRIORITY_LABELS,
	Project,
	STATUSES,
	STATUS_LABELS,
	Task,
	TaskPriority,
	TaskStatus,
} from "./types";

/** One form for both creating a task and editing an existing one (pass `task` to edit). */
export class TaskModal extends Modal {
	private task: Task | null;
	private title = "";
	private project: Project | null;
	private status: TaskStatus = "todo";
	private priority: TaskPriority = "medium";
	private due = "";
	private estimate = "";
	private category = "";
	private repeat = "";
	private blockedBy: string[] = []; // task note paths
	// Schedule shown as date + optional from/to times.
	private schedDate = "";
	private schedFrom = "";
	private schedTo = "";
	private otherEnd: string | null = null; // an end the form can't show (multi-day), kept as-is

	constructor(
		app: App,
		private store: TaskStore,
		opts: { project?: Project | null; task?: Task; status?: TaskStatus; scheduled?: string; scheduledEnd?: string | null }
	) {
		super(app);
		const t = opts.task ?? null;
		this.task = t;
		this.project = t?.project ?? opts.project ?? null;
		if (opts.status) this.status = opts.status;
		if (t) {
			this.title = t.title;
			this.status = t.status;
			this.priority = t.priority;
			this.due = t.due ?? "";
			this.estimate = t.estimate === null ? "" : String(t.estimate);
			this.category = t.category.join(", ");
			this.repeat = t.repeat ?? "";
			this.blockedBy = [...t.blockedByPaths];
		}
		this.loadSchedule(t?.scheduled ?? opts.scheduled ?? null, t?.scheduledEnd ?? opts.scheduledEnd ?? null);
	}

	onOpen(): void {
		const { contentEl } = this;
		const projects = this.store.getProjects();
		this.setTitle(this.task ? "Edit task" : "New task");

		if (projects.length === 0) {
			contentEl.createEl("p", { text: "No projects yet. Run \"Task Tracker: New project\" or \"Mark current note as project\" first." });
			return;
		}
		this.project ??= projects[0];

		new Setting(contentEl).setName("Title").addText((text) => {
			text
				.setPlaceholder("e.g. Setup TypeScript and Modules")
				.setValue(this.title)
				.onChange((v) => (this.title = v));
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.submit(false);
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});

		new Setting(contentEl).setName("Project").addDropdown((dd) => {
			for (const p of projects) dd.addOption(p.id, p.name);
			dd.setValue(this.project?.id ?? "").onChange((v) => {
				this.project = projects.find((p) => p.id === v) ?? null;
			});
		});

		new Setting(contentEl).setName("Status").addDropdown((dd) => {
			for (const s of STATUSES) dd.addOption(s, STATUS_LABELS[s]);
			dd.setValue(this.status).onChange((v) => (this.status = v as TaskStatus));
		});

		new Setting(contentEl).setName("Priority").addDropdown((dd) => {
			for (const p of PRIORITIES) dd.addOption(p, PRIORITY_LABELS[p]);
			dd.setValue(this.priority).onChange((v) => (this.priority = v as TaskPriority));
		});

		new Setting(contentEl).setName("Due date").addText((text) => {
			text.inputEl.type = "date";
			text.setValue(this.due).onChange((v) => (this.due = v));
		});

		const sched = new Setting(contentEl)
			.setName("Scheduled")
			.setDesc("When you'll work on it — shows on the calendar. Leave the times empty for all day.");
		sched.addText((text) => {
			text.inputEl.type = "date";
			text.setValue(this.schedDate).onChange((v) => (this.schedDate = v));
		});
		sched.addText((text) => {
			text.inputEl.type = "time";
			text.inputEl.setAttr("aria-label", "From");
			text.setValue(this.schedFrom).onChange((v) => (this.schedFrom = v));
		});
		sched.addText((text) => {
			text.inputEl.type = "time";
			text.inputEl.setAttr("aria-label", "To");
			text.setValue(this.schedTo).onChange((v) => (this.schedTo = v));
		});
		sched.controlEl.addClass("tt-sched-control");

		new Setting(contentEl)
			.setName("Estimate")
			.setDesc("Hours")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.step = "0.5";
				text.setValue(this.estimate).onChange((v) => (this.estimate = v));
			});

		new Setting(contentEl)
			.setName("Category")
			.setDesc("Comma separated, e.g. backend, design")
			.addText((text) => text.setValue(this.category).onChange((v) => (this.category = v)));

		new Setting(contentEl)
			.setName("Repeat")
			.setDesc("When it's closed, the next one is created automatically.")
			.addDropdown((dd) => {
				for (const [v, label] of REPEAT_OPTIONS) dd.addOption(v, label);
				// Keep a custom rule typed in the note (e.g. "every 3 days").
				if (this.repeat && !REPEAT_OPTIONS.some(([v]) => v === this.repeat)) dd.addOption(this.repeat, this.repeat);
				dd.setValue(this.repeat).onChange((v) => (this.repeat = v));
			});

		const blockers = new Setting(contentEl)
			.setName("Blocked by")
			.setDesc("Tasks that must be closed before this one can start.");
		const chips = blockers.controlEl.createDiv({ cls: "tt-blocker-chips" });
		const drawChips = () => {
			chips.empty();
			for (const path of this.blockedBy) {
				const chip = chips.createSpan({ cls: "tt-blocker-chip" });
				chip.createSpan({ text: path.split("/").pop()?.replace(/\.md$/, "") ?? path });
				const x = chip.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Remove" } });
				setIcon(x, "x");
				x.addEventListener("click", () => {
					this.blockedBy = this.blockedBy.filter((p) => p !== path);
					drawChips();
				});
			}
		};
		drawChips();
		blockers.addButton((btn) =>
			btn.setButtonText("Add").onClick(() => {
				const candidates = this.store
					.getTasks()
					.filter((t) => t.file.path !== this.task?.file.path && !this.blockedBy.includes(t.file.path));
				new TaskSuggestModal(
					this.app,
					candidates,
					(t) => {
						this.blockedBy.push(t.file.path);
						drawChips();
					},
					"Which task blocks this one?"
				).open();
			})
		);

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText(this.task ? "Save & open note" : "Create & open").onClick(() => this.submit(true))
			)
			.addButton((btn) =>
				btn
					.setButtonText(this.task ? "Save" : "Create task")
					.setCta()
					.onClick(() => this.submit(false))
			);
	}

	private async submit(openAfter: boolean): Promise<void> {
		const title = this.title.trim();
		if (!title) return void new Notice("Task title is required.");
		if (!this.project) return void new Notice("Pick a project.");

		const schedule = this.saveSchedule();
		if (!schedule) return; // a notice explained why
		const estimate = this.estimate === "" ? null : Number(this.estimate);
		const input: NewTaskInput = {
			title,
			project: this.project,
			status: this.status,
			priority: this.priority,
			due: this.due || null,
			estimate: estimate !== null && Number.isFinite(estimate) ? estimate : null,
			category: this.category.split(",").map((s) => s.trim()).filter(Boolean),
			repeat: this.repeat || null,
			blockedBy: this.blockedBy,
			scheduled: schedule.start,
			scheduledEnd: schedule.end,
		};

		try {
			let file: TFile;
			if (this.task) {
				file = await this.store.updateTask(this.task, input);
				new Notice("Task saved");
			} else {
				file = await this.store.createTask(input);
				new Notice(`Task created in ${this.project.name}`);
			}
			this.close();
			if (openAfter) await this.app.workspace.getLeaf(false).openFile(file);
		} catch (e) {
			new Notice(e instanceof Error ? e.message : "Failed to save task.");
		}
	}

	private loadSchedule(start: string | null, end: string | null): void {
		if (!start) return;
		const [date, time] = start.split("T");
		this.schedDate = date;
		this.schedFrom = time ?? "";
		if (end) {
			const [endDate, endTime] = end.split("T");
			if (time && endTime && endDate === date) this.schedTo = endTime;
			else this.otherEnd = end; // e.g. a multi-day block set on the calendar
		}
	}

	/** Form fields → `scheduled` / `scheduled-end`, or null (with a notice) if invalid. */
	private saveSchedule(): { start: string | null; end: string | null } | null {
		if (!this.schedDate) return { start: null, end: null };
		if (!this.schedFrom) {
			if (this.schedTo) {
				new Notice("Set a start time, or clear the end time for all day.");
				return null;
			}
			// All day: keep a multi-day end only if it's still on/after the start date.
			const keep = this.otherEnd && !this.otherEnd.includes("T") && this.otherEnd >= this.schedDate ? this.otherEnd : null;
			return { start: this.schedDate, end: keep };
		}
		const start = `${this.schedDate}T${this.schedFrom}`;
		if (this.schedTo) {
			if (this.schedTo <= this.schedFrom) {
				new Notice("The end time must be after the start time.");
				return null;
			}
			return { start, end: `${this.schedDate}T${this.schedTo}` };
		}
		const keep = this.otherEnd && this.otherEnd.includes("T") && this.otherEnd > start ? this.otherEnd : null;
		return { start, end: keep };
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
