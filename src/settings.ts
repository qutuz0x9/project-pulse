import { App, PluginSettingTab, Setting } from "obsidian";
import type ProjectPulsePlugin from "./main";

export interface ProjectPulseSettings {
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
	pomodoroSessions: PomodoroSession[]; // focus session history for statistics
}

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
