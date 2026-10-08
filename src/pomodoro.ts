import { Events, moment, Notice, TFile } from "obsidian";
import type { Moment } from "moment";
import type ProjectPulsePlugin from "./main";
import type { PomodoroPhase, PomodoroState } from "./settings";
import { today } from "./store";

/**
 * Pomodoro engine: focus → break (starts by itself) → waits for "Start focus".
 * State lives in the plugin's saved data, so a restart keeps it; a session that ended while
 * Obsidian was closed is completed on the next tick.
 *
 * Events: "changed" (phase/task/state changed → re-render), "tick" (every second → update clock).
 */
export class Pomodoro extends Events {
	private statusEl: HTMLElement;
	private completing = false;

	constructor(private plugin: ProjectPulsePlugin) {
		super();
		this.statusEl = plugin.addStatusBarItem();
		this.statusEl.addClass("tt-statusbar", "mod-clickable");
		this.statusEl.setAttr("aria-label", "Open Pomodoro");
		this.statusEl.addEventListener("click", () => plugin.activatePomodoroView());
		plugin.registerInterval(window.setInterval(() => this.tick(), 1000));
		this.renderStatusBar();
	}

	get state(): PomodoroState {
		return this.plugin.settings.pomodoro;
	}

	/** Anything other than idle: a focus session or break is running or paused. */
	isActive(): boolean {
		return this.state.phase !== "idle";
	}

	isPaused(): boolean {
		return this.state.pausedRemaining !== null;
	}

	task(): TFile | null {
		return this.state.taskPath ? this.plugin.app.vault.getFileByPath(this.state.taskPath) : null;
	}

	phaseLengthMs(phase: PomodoroPhase): number {
		const s = this.plugin.settings;
		const minutes =
			phase === "short-break" ? s.pomodoroShortBreak : phase === "long-break" ? s.pomodoroLongBreak : s.pomodoroFocus;
		return minutes * 60_000;
	}

	/** Time left in the current phase; when idle, the length of the next focus session. */
	remainingMs(): number {
		const s = this.state;
		if (s.endsAt !== null) return Math.max(0, s.endsAt - Date.now());
		if (s.pausedRemaining !== null) return s.pausedRemaining;
		return this.nextFocusMs();
	}

	/** Full length of the current phase (or of the next focus session when idle) — the ring's 100%. */
	totalMs(): number {
		const s = this.state;
		if (s.phase === "idle") return this.nextFocusMs();
		return s.phaseTotalMs ?? this.phaseLengthMs(s.phase);
	}

	private nextFocusMs(): number {
		return this.state.nextFocusMs ?? this.phaseLengthMs("focus");
	}

	/** ±1m buttons: change the time left (running/paused) or the next session's length (idle). Never below 1 min. */
	async adjust(deltaMs: number): Promise<void> {
		const s = this.state;
		const MIN = 60_000;
		if (s.phase === "idle") {
			s.nextFocusMs = Math.max(MIN, this.nextFocusMs() + deltaMs);
		} else {
			const left = this.remainingMs();
			const change = Math.max(MIN, left + deltaMs) - left;
			if (s.endsAt !== null) s.endsAt += change;
			else if (s.pausedRemaining !== null) s.pausedRemaining += change;
			s.phaseTotalMs = Math.max(MIN, this.totalMs() + change);
		}
		await this.save();
	}

	/** Finished (🍅) sessions today, from the session history. */
	completedToday(): number {
		const d = today();
		return this.plugin.settings.pomodoroSessions.filter((x) => x.completed && x.start.slice(0, 10) === d).length;
	}

	/** Removes a session from the statistics only — the task keeps its logged time. */
	async deleteSession(id: string): Promise<void> {
		this.plugin.settings.pomodoroSessions = this.plugin.settings.pomodoroSessions.filter((x) => x.id !== id);
		await this.save();
	}

	// ---------- actions ----------

	async selectTask(path: string | null): Promise<void> {
		if (this.state.phase === "focus" && path !== this.state.taskPath) await this.stop();
		this.state.taskPath = path;
		await this.save();
	}

	async startFocus(): Promise<void> {
		const file = this.task();
		if (!file) return void new Notice("Pick a task first.");

		await this.plugin.timer.stop(); // only one thing tracks time at a time
		const task = this.plugin.store.getTasks().find((t) => t.file.path === file.path);
		if (task?.status === "todo") await this.plugin.store.setStatus(file, "in-progress");

		const now = Date.now();
		const length = this.nextFocusMs();
		Object.assign(this.state, {
			phase: "focus",
			endsAt: now + length,
			pausedRemaining: null,
			focusMs: 0,
			runningSince: now,
			phaseTotalMs: length,
			nextFocusMs: null, // a ±1m change applies to one session only
		});
		await this.save();
	}

	async pause(): Promise<void> {
		const s = this.state;
		if (s.endsAt === null) return;
		const now = Date.now();
		if (s.phase === "focus" && s.runningSince !== null) s.focusMs += now - s.runningSince;
		s.pausedRemaining = Math.max(0, s.endsAt - now);
		s.endsAt = null;
		s.runningSince = null;
		await this.save();
	}

	async resume(): Promise<void> {
		const s = this.state;
		if (s.pausedRemaining === null) return;
		const now = Date.now();
		s.endsAt = now + s.pausedRemaining;
		s.pausedRemaining = null;
		if (s.phase === "focus") s.runningSince = now;
		await this.save();
	}

	/** Stops whatever is running. A focus session stopped early still logs its minutes (no 🍅). */
	async stop(): Promise<void> {
		const s = this.state;
		if (s.phase === "focus") {
			const focusMs = s.focusMs + (s.runningSince !== null ? Date.now() - s.runningSince : 0);
			await this.logFocus(focusMs, moment(), false);
		}
		this.reset();
		await this.save();
	}

	/** Marks the task Done. A running focus session is stopped first so its time is logged. */
	async completeTask(): Promise<void> {
		const file = this.task();
		if (!file) return;
		if (this.state.phase === "focus") await this.stop();
		await this.plugin.store.setStatus(file, "done");
		new Notice(`Done: ${file.basename}`);
	}

	async skipBreak(): Promise<void> {
		if (this.state.phase === "focus") return;
		this.reset();
		await this.save();
	}

	/** Keep following the task if its note is renamed/moved. */
	async onRename(file: TFile, oldPath: string): Promise<void> {
		if (this.state.taskPath !== oldPath) return;
		this.state.taskPath = file.path;
		await this.save();
	}

	/** Its task was deleted: nothing left to log to. */
	async onDelete(file: TFile): Promise<void> {
		if (this.state.taskPath !== file.path) return;
		if (this.state.phase === "focus") this.reset();
		this.state.taskPath = null;
		await this.save();
	}

	// ---------- internals ----------

	private async tick(): Promise<void> {
		this.renderStatusBar();
		this.trigger("tick");
		const s = this.state;
		if (s.endsAt !== null && Date.now() >= s.endsAt && !this.completing) {
			this.completing = true;
			try {
				await this.completePhase();
			} finally {
				this.completing = false;
			}
		}
	}

	private async completePhase(): Promise<void> {
		const s = this.state;
		const endedAt = s.endsAt ?? Date.now();
		const name = this.task()?.basename ?? "Task";

		if (s.phase === "focus") {
			const focusMs = s.focusMs + (s.runningSince !== null ? endedAt - s.runningSince : 0);
			await this.logFocus(focusMs, moment(endedAt), true);
			s.round += 1;
			const long = s.round % this.plugin.settings.pomodoroLongEvery === 0;
			const breakPhase: PomodoroPhase = long ? "long-break" : "short-break";
			// The break starts by itself.
			Object.assign(s, {
				phase: breakPhase,
				endsAt: Date.now() + this.phaseLengthMs(breakPhase),
				pausedRemaining: null,
				focusMs: 0,
				runningSince: null,
				phaseTotalMs: this.phaseLengthMs(breakPhase),
			});
			const minutes = Math.round(this.phaseLengthMs(breakPhase) / 60_000);
			this.notify("Focus session done 🍅", `${name}: logged. Take a ${minutes}-minute ${long ? "long " : ""}break.`);
		} else {
			// Break over: wait for the user to start the next focus session.
			this.reset();
			this.notify("Break over", `Ready for the next focus session on ${name}.`);
		}
		await this.save();
	}

	/** Writes focus time to the task (`spent` + `time-log`); `full` also counts a 🍅. */
	private async logFocus(focusMs: number, end: Moment, full: boolean): Promise<void> {
		const file = this.task();
		if (!file) return;
		if (focusMs < 60_000) {
			if (!full) new Notice("Focus under 1 minute — not logged.");
			return;
		}
		try {
			await this.plugin.store.addTimeEntry(file, end.clone().subtract(focusMs, "ms"), end, full);
			const start = end.clone().subtract(focusMs, "ms");
			this.plugin.settings.pomodoroSessions.push({
				id: `${start.valueOf()}`,
				start: start.format("YYYY-MM-DDTHH:mm:ss"),
				end: end.format("YYYY-MM-DDTHH:mm:ss"),
				minutes: Math.round(focusMs / 60_000),
				task: file.path,
				title: file.basename,
				completed: full,
			});
			if (!full) new Notice(`Logged ${Math.floor(focusMs / 60_000)} min on ${file.basename}`);
		} catch (e) {
			new Notice(`Project Pulse: couldn't save focus time — ${e instanceof Error ? e.message : "unknown error"}`);
		}
	}

	private reset(): void {
		Object.assign(this.state, {
			phase: "idle",
			endsAt: null,
			pausedRemaining: null,
			focusMs: 0,
			runningSince: null,
			phaseTotalMs: null,
		});
	}

	private async save(): Promise<void> {
		await this.plugin.saveSettings();
		this.renderStatusBar();
		this.trigger("changed");
	}

	private notify(title: string, body: string): void {
		new Notice(`${title}\n${body}`, 8000);
		if (this.plugin.settings.pomodoroSound) playChime();
		if (this.plugin.settings.pomodoroSystemNotify && typeof Notification !== "undefined") {
			try {
				new Notification(title, { body, silent: true });
			} catch {
				// System notifications unavailable (e.g. on mobile) — the Obsidian notice is enough.
			}
		}
	}

	private renderStatusBar(): void {
		const s = this.state;
		if (s.phase === "idle") {
			this.statusEl.hide();
			return;
		}
		const icon = s.phase === "focus" ? "🍅" : "☕";
		const label = s.phase === "focus" ? this.task()?.basename ?? "Focus" : "Break";
		this.statusEl.show();
		this.statusEl.setText(`${icon} ${formatClock(this.remainingMs())}${this.isPaused() ? " ⏸" : ""} · ${label}`);
	}
}

/** Milliseconds → "MM:SS" (rounded up so 0:00 shows only when time is really up). */
export function formatClock(ms: number): string {
	const total = Math.ceil(ms / 1000);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Short two-note chime made with the Web Audio API (no sound file needed). */
function playChime(): void {
	try {
		const ctx = new AudioContext();
		const notes = [880, 1320];
		notes.forEach((freq, i) => {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = "sine";
			osc.frequency.value = freq;
			const t0 = ctx.currentTime + i * 0.22;
			gain.gain.setValueAtTime(0.0001, t0);
			gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
			osc.connect(gain).connect(ctx.destination);
			osc.start(t0);
			osc.stop(t0 + 0.55);
		});
		window.setTimeout(() => ctx.close(), 1500);
	} catch {
		// Audio not available — ignore.
	}
}
