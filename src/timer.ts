import { moment, Notice, setIcon, TFile } from "obsidian";
import type ProjectPulsePlugin from "./main";

/**
 * One timer at a time. The running timer lives in the plugin's saved data (not in memory only),
 * so closing Obsidian doesn't lose it. Stopping writes a `time-log` entry + adds to `spent`.
 */
export class TaskTimer {
	private statusEl: HTMLElement;

	constructor(private plugin: ProjectPulsePlugin) {
		this.statusEl = plugin.addStatusBarItem();
		this.statusEl.addClass("tt-statusbar", "mod-clickable");
		this.statusEl.setAttr("aria-label", "Click to stop the task timer");
		this.statusEl.addEventListener("click", () => this.stop());
		// Tick the status bar clock every second.
		plugin.registerInterval(window.setInterval(() => this.renderStatusBar(), 1000));
		this.renderStatusBar();
	}

	isRunning(file: TFile): boolean {
		return this.plugin.settings.activeTimer?.path === file.path;
	}

	async toggle(file: TFile): Promise<void> {
		if (this.isRunning(file)) await this.stop();
		else await this.start(file);
	}

	async start(file: TFile): Promise<void> {
		if (this.isRunning(file)) return;
		await this.stop(); // only one timer at a time
		if (this.plugin.pomodoro.isActive()) await this.plugin.pomodoro.stop(); // shared with the Pomodoro
		this.plugin.settings.activeTimer = { path: file.path, start: new Date().toISOString() };
		await this.plugin.saveSettings();
		this.renderStatusBar();
		new Notice(`Timer started: ${file.basename}`);
	}

	async stop(): Promise<void> {
		const active = this.plugin.settings.activeTimer;
		if (!active) return;

		const start = moment(active.start);
		const end = moment();
		const file = this.plugin.app.vault.getFileByPath(active.path);
		const minutes = end.diff(start, "minutes");

		if (file && minutes >= 1) {
			try {
				await this.plugin.store.addTimeEntry(file, start, end);
				new Notice(`Logged ${formatDuration(end.diff(start))} on ${file.basename}`);
			} catch (e) {
				// Keep the timer running so the time isn't lost; the user can try stopping again.
				new Notice(`Project Pulse: couldn't save time — ${e instanceof Error ? e.message : "unknown error"}`);
				return;
			}
		} else if (file) {
			new Notice("Timer under 1 minute — not logged.");
		}

		this.plugin.settings.activeTimer = null;
		await this.plugin.saveSettings();
		this.renderStatusBar();
	}

	/** Keep following the task if its note is renamed/moved while the timer runs. */
	async onRename(file: TFile, oldPath: string): Promise<void> {
		const active = this.plugin.settings.activeTimer;
		if (active?.path !== oldPath) return;
		active.path = file.path;
		await this.plugin.saveSettings();
	}

	/** Drop the timer if its task note is deleted (nothing left to log to). */
	async onDelete(file: TFile): Promise<void> {
		if (!this.isRunning(file)) return;
		this.plugin.settings.activeTimer = null;
		await this.plugin.saveSettings();
		this.renderStatusBar();
	}

	private renderStatusBar(): void {
		const active = this.plugin.settings.activeTimer;
		if (!active) {
			this.statusEl.hide();
			return;
		}
		const name = active.path.split("/").pop()?.replace(/\.md$/, "") ?? "";
		this.statusEl.show();
		this.statusEl.setText(`⏱ ${name} · ${formatDuration(moment().diff(moment(active.start)))}`);
	}
}

/** Milliseconds → "H:MM:SS". */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** ▶ / ■ button used on list rows and board cards. */
export function timerButton(parent: HTMLElement, plugin: ProjectPulsePlugin, file: TFile): HTMLElement {
	const running = plugin.timer.isRunning(file);
	const btn = parent.createEl("button", {
		cls: `clickable-icon tt-timer-btn${running ? " is-running" : ""}`,
		attr: { "aria-label": running ? "Stop timer" : "Start timer" },
	});
	setIcon(btn, running ? "square" : "play");
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		plugin.timer.toggle(file);
	});
	return btn;
}
