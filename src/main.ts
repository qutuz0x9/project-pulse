import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import { BoardView, VIEW_TYPE_BOARD } from "./BoardView";
import { DashboardView, VIEW_TYPE_DASHBOARD } from "./DashboardView";
import { ConfirmModal } from "./ConfirmModal";
import { TaskModal } from "./TaskModal";
import { QuickAddModal } from "./QuickAddModal";
import { TodayView, VIEW_TYPE_TODAY } from "./TodayView";
import { CalendarView, VIEW_TYPE_CALENDAR } from "./CalendarView";
import { registerCodeBlock } from "./codeBlock";
import { createWeeklyReview } from "./weeklyReview";
import { ProjectModal } from "./ProjectModal";
import { DEFAULT_SETTINGS, ProjectPulseSettings, ProjectPulseSettingTab } from "./settings";
import { TaskStore } from "./store";
import { TaskListView, VIEW_TYPE_TASK_LIST } from "./TaskListView";
import { TaskTimer } from "./timer";
import { Pomodoro } from "./pomodoro";
import { PomodoroView, VIEW_TYPE_POMODORO } from "./PomodoroView";
import { PomodoroStatsView, VIEW_TYPE_POMODORO_STATS } from "./PomodoroStatsView";
import { Project, Task, TaskStatus } from "./types";

export default class ProjectPulsePlugin extends Plugin {
	settings: ProjectPulseSettings;
	store: TaskStore;
	timer: TaskTimer;
	pomodoro: Pomodoro;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.store = new TaskStore(this.app, this.settings);
		this.timer = new TaskTimer(this);
		this.pomodoro = new Pomodoro(this);

		this.registerView(VIEW_TYPE_TASK_LIST, (leaf) => new TaskListView(leaf, this));
		this.registerView(VIEW_TYPE_DASHBOARD, (leaf) => new DashboardView(leaf, this));
		this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this));
		this.registerView(VIEW_TYPE_POMODORO, (leaf) => new PomodoroView(leaf, this));
		this.registerView(VIEW_TYPE_TODAY, (leaf) => new TodayView(leaf, this));
		this.registerView(VIEW_TYPE_CALENDAR, (leaf) => new CalendarView(leaf, this));
		registerCodeBlock(this);
		this.registerView(VIEW_TYPE_POMODORO_STATS, (leaf) => new PomodoroStatsView(leaf, this));

		this.addRibbonIcon("list-checks", "Open task list", () => this.activateView(VIEW_TYPE_TASK_LIST));
		this.addRibbonIcon("layout-dashboard", "Open task dashboard", () => this.activateView(VIEW_TYPE_DASHBOARD));
		this.addRibbonIcon("kanban", "Open task board", () => this.activateView(VIEW_TYPE_BOARD));
		this.addRibbonIcon("timer", "Open Pomodoro", () => this.activatePomodoroView());
		this.addRibbonIcon("trending-up", "Open Pomodoro statistics", () => this.openPomodoroStats());
		this.addRibbonIcon("sun", "Open Today", () => this.activateView(VIEW_TYPE_TODAY));
		this.addRibbonIcon("calendar-days", "Open task calendar", () => this.activateView(VIEW_TYPE_CALENDAR));

		this.addCommand({
			id: "open-calendar",
			name: "Open calendar",
			callback: () => this.activateView(VIEW_TYPE_CALENDAR),
		});

		this.addCommand({
			id: "open-today",
			name: "Open Today",
			callback: () => this.activateView(VIEW_TYPE_TODAY),
		});

		this.addCommand({
			id: "quick-add",
			name: "Quick add task",
			callback: () => this.openQuickAdd(),
		});

		this.addCommand({
			id: "weekly-review",
			name: "Create weekly review (this week)",
			callback: () => createWeeklyReview(this, 0),
		});

		this.addCommand({
			id: "weekly-review-last",
			name: "Create weekly review (last week)",
			callback: () => createWeeklyReview(this, -1),
		});

		this.addCommand({
			id: "open-pomodoro",
			name: "Open Pomodoro",
			callback: () => this.activatePomodoroView(),
		});

		this.addCommand({
			id: "open-pomodoro-stats",
			name: "Open Pomodoro statistics",
			callback: () => this.activateView(VIEW_TYPE_POMODORO_STATS),
		});

		this.addCommand({
			id: "pomodoro-current-task",
			name: "Start Pomodoro for current task",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.store.isTask(file)) return false;
				if (!checking) this.startPomodoroFor(file);
				return true;
			},
		});

		this.addCommand({
			id: "pomodoro-stop",
			name: "Stop Pomodoro",
			checkCallback: (checking) => {
				if (!this.pomodoro.isActive()) return false;
				if (!checking) this.pomodoro.stop();
				return true;
			},
		});

		this.addCommand({
			id: "open-task-list",
			name: "Open task list",
			callback: () => this.activateView(VIEW_TYPE_TASK_LIST),
		});

		this.addCommand({
			id: "open-dashboard",
			name: "Open dashboard",
			callback: () => this.activateView(VIEW_TYPE_DASHBOARD),
		});

		this.addCommand({
			id: "open-board",
			name: "Open board",
			callback: () => this.activateView(VIEW_TYPE_BOARD),
		});

		this.addCommand({
			id: "new-task",
			name: "New task",
			callback: () => {
				// Pre-select the project of the note you're currently in.
				const active = this.app.workspace.getActiveFile();
				this.openNewTaskModal(active ? this.store.projectForFile(active) : null);
			},
		});

		this.addCommand({
			id: "toggle-timer",
			name: "Start/stop timer for current task",
			checkCallback: (checking) => {
				// Only available while a task note is open.
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.store.isTask(file)) return false;
				if (!checking) this.timer.toggle(file);
				return true;
			},
		});

		this.addCommand({
			id: "stop-timer",
			name: "Stop timer",
			checkCallback: (checking) => {
				if (!this.settings.activeTimer) return false;
				if (!checking) this.timer.stop();
				return true;
			},
		});

		this.addCommand({
			id: "edit-task",
			name: "Edit current task",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const task = file ? this.store.getTasks().find((t) => t.file.path === file.path) : undefined;
				if (!task) return false;
				if (!checking) this.openEditTaskModal(task);
				return true;
			},
		});

		this.addCommand({
			id: "delete-task",
			name: "Delete current task",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.store.isTask(file)) return false;
				if (!checking) this.confirmDeleteTask(file);
				return true;
			},
		});

		this.addCommand({
			id: "new-project",
			name: "New project",
			callback: () =>
				new ProjectModal(this.app, "New project", "", "Create project", async (name) => {
					const file = await this.store.createProject(name);
					await this.app.workspace.getLeaf(false).openFile(file);
					new Notice(`Project "${name}" created`);
				}).open(),
		});

		this.addCommand({
			id: "mark-as-project",
			name: "Mark current note as project",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md" || this.store.isProject(file) || this.store.isTask(file)) return false;
				if (!checking) {
					new ProjectModal(this.app, "Mark as project", suggestProjectName(file.basename), "Save", async (name) => {
						await this.store.markAsProject(file, name);
						new Notice(`"${name}" is now a project`);
					}).open();
				}
				return true;
			},
		});

		this.addCommand({
			id: "unmark-project",
			name: "Remove current note from projects",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.store.isProject(file)) return false;
				if (!checking) {
					this.store
						.unmarkProject(file)
						.then(() => new Notice("Removed from projects. Its task notes were kept."));
				}
				return true;
			},
		});

		this.addSettingTab(new ProjectPulseSettingTab(this.app, this));

		// Start listening after startup so the initial vault indexing doesn't flood events.
		this.app.workspace.onLayoutReady(() => {
			const onChange = (file: TAbstractFile) => {
				if (file instanceof TFile) this.store.onFileChanged(file);
			};
			this.registerEvent(this.app.metadataCache.on("changed", onChange));
			this.registerEvent(
				this.app.vault.on("delete", (file) => {
					onChange(file);
					if (file instanceof TFile) {
						this.timer.onDelete(file);
						this.pomodoro.onDelete(file);
					}
				})
			);
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => {
					onChange(file);
					if (file instanceof TFile) {
						this.timer.onRename(file, oldPath);
						this.pomodoro.onRename(file, oldPath);
					}
				})
			);
		});
	}

	openNewTaskModal(project: Project | null, status?: TaskStatus, schedule?: { start: string; end: string | null }): void {
		new TaskModal(this.app, this.store, { project, status, scheduled: schedule?.start, scheduledEnd: schedule?.end }).open();
	}

	/** Quick add, defaulting to the project of the note you're in. */
	openQuickAdd(): void {
		const active = this.app.workspace.getActiveFile();
		new QuickAddModal(this.app, this.store, active ? this.store.projectForFile(active) : null).open();
	}

	openEditTaskModal(task: Task): void {
		new TaskModal(this.app, this.store, { task }).open();
	}

	/** Asks first, then moves the task note to the trash (follows Obsidian's "Deleted files" setting). */
	confirmDeleteTask(file: TFile): void {
		new ConfirmModal(this.app, "Delete task", `Delete "${file.basename}"? The note is moved to the trash.`, "Delete", () => {
			this.app.fileManager
				.trashFile(file)
				.then(() => new Notice(`Deleted "${file.basename}"`))
				.catch((e) => new Notice(`Project Pulse: ${e instanceof Error ? e.message : "delete failed"}`));
		}).open();
	}

	/** Opens the Pomodoro panel in the right sidebar (or reveals it). */
	async activatePomodoroView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_POMODORO)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_POMODORO, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	openCalendarView(): Promise<void> {
		return this.activateView(VIEW_TYPE_CALENDAR);
	}

	openTodayView(): Promise<void> {
		return this.activateView(VIEW_TYPE_TODAY);
	}

	openPomodoroStats(): Promise<void> {
		return this.activateView(VIEW_TYPE_POMODORO_STATS);
	}

	/** Picks the task in the Pomodoro panel, starts a focus session and shows the panel. */
	async startPomodoroFor(file: TFile): Promise<void> {
		await this.pomodoro.selectTask(file.path);
		await this.pomodoro.startFocus();
		await this.activatePomodoroView();
	}

	/** Focus the view's tab if it's already open, otherwise open it in a new tab. */
	async activateView(type: string): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(type)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		delete data?.projectsFolder; // old setting from folder-based projects
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Nested object: merge so new fields get their defaults.
		this.settings.pomodoro = { ...DEFAULT_SETTINGS.pomodoro, ...data?.pomodoro };
		this.settings.pomodoroSessions = [...(data?.pomodoroSessions ?? [])]; // own copy, never the default array
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.store.trigger("changed");
	}
}

// "00- Food Delivery Clone - Overview" → "Food Delivery Clone"
function suggestProjectName(basename: string): string {
	return basename.replace(/^\d+-\s*/, "").replace(/\s*-?\s*Overview$/i, "").trim() || basename;
}
