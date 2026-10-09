import { App, PluginSettingTab, Setting } from "obsidian";
import type ProjectPulsePlugin from "./main";

export interface ProjectPulseSettings {
	taskTag: string; // tag that marks a note as a task (no "#")
	statusProperty: string; // frontmatter property holding todo / in-progress / done / failed
	projectProperty: string; // frontmatter property that makes a note a project (value = display name)
	newProjectsFolder: string; // "New project" creates <folder>/<name>/<name>.md
	tasksSubfolder: string; // task notes go to <project folder>/<tasksSubfolder>/
	reviewsFolder: string; // where weekly review notes are created
	dailyBudget: number; // hours of work planned per day (Today view "Planned today" bar)
	activeTimer: ActiveTimer | null; // runtime state (not shown in the settings tab), saved so it survives restarts
	pomodoroFocus: number; // minutes
	pomodoroShortBreak: number; // minutes
	pomodoroLongBreak: number; // minutes
	pomodoroLongEvery: number; // long break after this many focus sessions
	pomodoroSound: boolean;
	pomodoroSystemNotify: boolean;
	pomodoro: PomodoroState; // runtime state (not shown in the settings tab)
	pomodoroSessions: PomodoroSession[]; // focus session history for statistics (newest MAX_SESSIONS kept)
	pomodoroArchive: PomodoroArchive; // totals of older sessions trimmed from the history, so all-time stats stay right
	ribbonIcons: Record<RibbonKey, boolean>; // which sidebar icons are shown
}

/** Totals of focus sessions that were trimmed from `pomodoroSessions`. */
export interface PomodoroArchive {
	sessions: number;
	pomodoros: number;
	minutes: number;
}

export type RibbonKey = "today" | "dashboard" | "board" | "list" | "calendar" | "pomodoro" | "stats";

/** Sidebar icons in display order, with their labels for the settings tab. */
export const RIBBON_ITEMS: [RibbonKey, string][] = [
	["today", "Today"],
	["dashboard", "Dashboard"],
	["board", "Board"],
	["list", "Task list"],
	["calendar", "Calendar"],
	["pomodoro", "Pomodoro"],
	["stats", "Pomodoro statistics"],
];

export type PomodoroPhase = "idle" | "focus" | "short-break" | "long-break";

export interface PomodoroState {
	taskPath: string | null; // the task picked in the panel
	phase: PomodoroPhase;
	endsAt: number | null; // ms timestamp while running
	pausedRemaining: number | null; // ms left while paused
	focusMs: number; // focus time already done in this session (before the current running stretch)
	runningSince: number | null; // ms timestamp the current focus stretch started
	round: number; // finished focus sessions in the current cycle
	phaseTotalMs: number | null; // full length of the current phase (changes with ±1m), for the ring
	nextFocusMs: number | null; // length of the next focus session if changed with ±1m while idle
}

/** One focus session in the history used by Pomodoro statistics. */
export interface PomodoroSession {
	id: string;
	start: string; // ISO date-time
	end: string; // ISO date-time
	minutes: number; // focus minutes (pauses excluded)
	task: string; // task note path at the time
	title: string; // task title at the time (kept even if the note is renamed/deleted)
	completed: boolean; // true = full session (🍅), false = stopped early
}

export interface ActiveTimer {
	path: string; // task note path
	start: string; // ISO date-time
}

export const DEFAULT_SETTINGS: ProjectPulseSettings = {
	taskTag: "type/task",
	statusProperty: "task-status",
	projectProperty: "tracker-project",
	newProjectsFolder: "Project Pulse",
	tasksSubfolder: "Tasks",
	reviewsFolder: "Project Pulse/Reviews",
	dailyBudget: 4,
	activeTimer: null,
	pomodoroFocus: 25,
	pomodoroShortBreak: 5,
	pomodoroLongBreak: 15,
	pomodoroLongEvery: 4,
	pomodoroSound: true,
	pomodoroSystemNotify: true,
	pomodoro: {
		taskPath: null,
		phase: "idle",
		endsAt: null,
		pausedRemaining: null,
		focusMs: 0,
		runningSince: null,
		round: 0,
		phaseTotalMs: null,
		nextFocusMs: null,
	},
	pomodoroSessions: [],
	pomodoroArchive: { sessions: 0, pomodoros: 0, minutes: 0 },
	// New installs start with the three main views; the rest are one toggle away.
	ribbonIcons: { today: true, dashboard: true, board: true, list: false, calendar: false, pomodoro: false, stats: false },
};

export class ProjectPulseSettingTab extends PluginSettingTab {
	plugin: ProjectPulsePlugin;

	constructor(app: App, plugin: ProjectPulsePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Note format")
			.setDesc("How tasks and projects are recognized. Changing these doesn't rename existing notes' properties.")
			.setHeading();
		const name = (label: string, desc: string, key: "taskTag" | "statusProperty" | "projectProperty") =>
			new Setting(containerEl)
				.setName(label)
				.setDesc(desc)
				.addText((text) =>
					text
						.setPlaceholder(DEFAULT_SETTINGS[key])
						.setValue(this.plugin.settings[key])
						.onChange(async (value) => {
							const v = value.trim().replace(/^#/, "").replace(/\s+/g, "-");
							this.plugin.settings[key] = v || DEFAULT_SETTINGS[key];
							await this.plugin.saveSettings();
						})
				);
		name("Task tag", "Notes with this tag are tasks (without #).", "taskTag");
		name("Status property", "Property that holds todo / in-progress / done / failed.", "statusProperty");
		name("Project property", "Any note with this property is a project; its value is the project name.", "projectProperty");
		new Setting(containerEl)
			.setName("Sidebar icons")
			.setDesc("Every view also has a command (Ctrl/Cmd+P), so hidden icons are never out of reach.")
			.setHeading();
		for (const [key, label] of RIBBON_ITEMS) {
			new Setting(containerEl).setName(label).addToggle((t) =>
				t.setValue(this.plugin.settings.ribbonIcons[key]).onChange(async (v) => {
					this.plugin.settings.ribbonIcons[key] = v;
					this.plugin.applyRibbonIcons();
					await this.plugin.saveSettings();
				})
			);
		}

		new Setting(containerEl).setName("Folders").setHeading();

		new Setting(containerEl)
			.setName("New projects folder")
			.setDesc('Where "New project" creates project notes. Any note can also become a project with "Mark current note as project".')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.newProjectsFolder)
					.setValue(this.plugin.settings.newProjectsFolder)
					.onChange(async (value) => {
						this.plugin.settings.newProjectsFolder = value.trim() || DEFAULT_SETTINGS.newProjectsFolder;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Tasks subfolder")
			.setDesc("Folder inside each project where new task notes are created.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.tasksSubfolder)
					.setValue(this.plugin.settings.tasksSubfolder)
					.onChange(async (value) => {
						this.plugin.settings.tasksSubfolder = value.trim() || DEFAULT_SETTINGS.tasksSubfolder;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Weekly reviews folder")
			.setDesc("Where \"Create weekly review\" saves its notes.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.reviewsFolder)
					.setValue(this.plugin.settings.reviewsFolder)
					.onChange(async (value) => {
						this.plugin.settings.reviewsFolder = value.trim() || DEFAULT_SETTINGS.reviewsFolder;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Daily budget")
			.setDesc("Hours of work you plan per day — the Today view compares what's due and scheduled against it.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0.5";
				text.inputEl.step = "0.5";
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.dailyBudget))
					.setValue(String(this.plugin.settings.dailyBudget))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.dailyBudget = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.dailyBudget;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("Pomodoro").setHeading();

		const minutes = (
			name: string,
			desc: string,
			key: "pomodoroFocus" | "pomodoroShortBreak" | "pomodoroLongBreak" | "pomodoroLongEvery"
		) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((text) => {
					text.inputEl.type = "number";
					text.inputEl.min = "1";
					text
						.setPlaceholder(String(DEFAULT_SETTINGS[key]))
						.setValue(String(this.plugin.settings[key]))
						.onChange(async (value) => {
							const n = Math.round(Number(value));
							this.plugin.settings[key] = Number.isFinite(n) && n >= 1 ? n : DEFAULT_SETTINGS[key];
							await this.plugin.saveSettings();
						});
				});

		minutes("Focus length", "Minutes per focus session.", "pomodoroFocus");
		minutes("Short break", "Minutes.", "pomodoroShortBreak");
		minutes("Long break", "Minutes.", "pomodoroLongBreak");
		minutes("Long break every", "Take a long break after this many focus sessions.", "pomodoroLongEvery");

		new Setting(containerEl)
			.setName("Sound")
			.setDesc("Play a chime when a session ends.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.pomodoroSound).onChange(async (v) => {
					this.plugin.settings.pomodoroSound = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("System notification")
			.setDesc("Show a desktop notification when a session ends, even if Obsidian isn't focused.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.pomodoroSystemNotify).onChange(async (v) => {
					this.plugin.settings.pomodoroSystemNotify = v;
					await this.plugin.saveSettings();
				})
			);
	}
}
