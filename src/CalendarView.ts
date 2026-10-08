import { Calendar, DateSelectArg, EventClickArg, EventContentArg, EventDropArg, EventInput } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin, { EventResizeDoneArg } from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import multiMonthPlugin from "@fullcalendar/multimonth";
import timeGridPlugin from "@fullcalendar/timegrid";
import { ItemView, moment, Notice, WorkspaceLeaf } from "obsidian";
import type ProjectPulsePlugin from "./main";
import { today } from "./store";
import { FM, isClosed, Task } from "./types";

export const VIEW_TYPE_CALENDAR = "project-pulse-calendar";

type EventKind = "scheduled" | "due" | "logged";

/**
 * Calendar (FullCalendar v6) showing three kinds of events:
 *  - scheduled: the task's `scheduled` / `scheduled-end` period — drag to move, stretch to resize
 *  - due:       ⚑ flag on the due date of tasks that aren't scheduled — drag to change the due date
 *  - logged:    ⏱ hatched shading from `time-log` (▶ timer and Pomodoro) — what actually happened, read-only
 * Drag across empty time to create a task for that slot.
 */
export class CalendarView extends ItemView {
	private calendar: Calendar | null = null;
	private projectFilter = "all";
	private showDue = true;
	private showLogged = true;

	constructor(leaf: WorkspaceLeaf, private plugin: ProjectPulsePlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CALENDAR;
	}

	getDisplayText(): string {
		return "Calendar";
	}

	getIcon(): string {
		return "calendar-days";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("tt-cal");

		this.renderFilters(root.createDiv({ cls: "tt-cal-filters" }));
		const host = root.createDiv({ cls: "tt-cal-host" });

		this.calendar = new Calendar(host, {
			plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, multiMonthPlugin],
			initialView: "timeGridWeek",
			headerToolbar: {
				left: "prev,next today",
				center: "title",
				right: "multiMonthYear,dayGridMonth,timeGridWeek,timeGridThreeDay,timeGridDay,listWeek",
			},
			views: {
				multiMonthYear: { buttonText: "Y" },
				dayGridMonth: { buttonText: "M" },
				timeGridWeek: { buttonText: "W" },
				timeGridThreeDay: { type: "timeGrid", duration: { days: 3 }, buttonText: "3D" },
				timeGridDay: { buttonText: "D" },
				listWeek: { buttonText: "List" },
			},
			buttonText: { today: "Today" },
			firstDay: moment.localeData().firstDayOfWeek(),
			height: "100%",
			weekNumbers: true,
			nowIndicator: true,
			editable: true,
			selectable: true,
			selectMirror: true,
			dayMaxEvents: true,
			slotDuration: "00:30:00",
			scrollTime: `${String(Math.max(0, new Date().getHours() - 1)).padStart(2, "0")}:00:00`,
			defaultTimedEventDuration: "01:00",
			events: (info, success) => success(this.buildEvents(info.start, info.end)),
			eventContent: (arg) => this.renderEvent(arg),
			eventDidMount: (arg) => {
				// Hover text for tracked-time shading.
				if (arg.event.extendedProps.kind === "logged") {
					arg.el.setAttr("aria-label", `Tracked: ${arg.event.title} (${arg.event.extendedProps.minutes} min)`);
				}
			},
			eventDrop: (info) => this.onMove(info),
			eventResize: (info) => this.onMove(info),
			select: (info) => this.onSelect(info),
			eventClick: (info) => this.onClick(info),
		});
		this.calendar.render();

		this.registerEvent(this.plugin.store.on("changed", () => this.calendar?.refetchEvents()));
	}

	onResize(): void {
		this.calendar?.updateSize();
	}

	async onClose(): Promise<void> {
		this.calendar?.destroy();
		this.calendar = null;
		this.contentEl.empty();
	}

	private renderFilters(bar: HTMLElement): void {
		const projects = this.plugin.store.getProjects();
		const sel = bar.createEl("select", { cls: "dropdown" });
		sel.createEl("option", { value: "all", text: "All projects" });
		for (const p of projects) sel.createEl("option", { value: p.id, text: p.name });
		sel.value = this.projectFilter;
		sel.addEventListener("change", () => {
			this.projectFilter = sel.value;
			this.calendar?.refetchEvents();
		});

		const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
			const wrap = bar.createEl("label", { cls: "tt-cal-toggle" });
			const box = wrap.createEl("input", { type: "checkbox" });
			box.checked = get();
			box.addEventListener("change", () => {
				set(box.checked);
				this.calendar?.refetchEvents();
			});
			wrap.appendText(label);
		};
		toggle("⚑ Due dates", () => this.showDue, (v) => (this.showDue = v));
		toggle("⏱ Tracked time", () => this.showLogged, (v) => (this.showLogged = v));
		bar.createSpan({ cls: "tt-cal-hint", text: "Drag across empty time to add a task · Ctrl+click opens the note" });
	}

	// ---------- events ----------

	private buildEvents(rangeStart: Date, rangeEnd: Date): EventInput[] {
		const from = moment(rangeStart).format("YYYY-MM-DD");
		const to = moment(rangeEnd).format("YYYY-MM-DD");
		const tasks = this.plugin.store
			.getTasks()
			.filter((t) => this.projectFilter === "all" || t.project?.id === this.projectFilter);

		const events: EventInput[] = [];
		for (const t of tasks) {
			const base = { path: t.file.path, status: t.status, project: t.project?.name ?? "" };
			const state = isClosed(t.status) ? `is-${t.status}` : "";

			if (t.scheduled) {
				const timed = t.scheduled.includes("T");
				let end: string | undefined;
				if (timed) {
					end = t.scheduledEnd?.includes("T")
						? t.scheduledEnd
						: moment(t.scheduled).add(t.estimate ?? 1, "hours").format("YYYY-MM-DDTHH:mm");
				} else if (t.scheduledEnd && !t.scheduledEnd.includes("T") && t.scheduledEnd > t.scheduled) {
					end = moment(t.scheduledEnd).add(1, "day").format("YYYY-MM-DD"); // calendar ends are exclusive
				}
				events.push({
					id: `s:${t.file.path}`,
					title: t.title,
					start: t.scheduled,
					end,
					allDay: !timed,
					classNames: ["tt-ev", `tt-ev-${t.priority}`, state],
					extendedProps: { ...base, kind: "scheduled" as EventKind, hasEnd: !!t.scheduledEnd },
				});
			}

			// Due flag — skipped when the task is already scheduled as all-day on that same date.
			const dueCoveredBySchedule = t.scheduled && !t.scheduled.includes("T") && t.scheduled === t.due;
			if (this.showDue && t.due && !isClosed(t.status) && !dueCoveredBySchedule && t.due >= from && t.due <= to) {
				events.push({
					id: `d:${t.file.path}`,
					title: t.title,
					start: t.due,
					allDay: true,
					durationEditable: false,
					classNames: ["tt-ev-due", t.due < today() ? "is-late" : ""],
					extendedProps: { ...base, kind: "due" as EventKind },
				});
			}

			if (this.showLogged) events.push(...this.loggedEvents(t, from, to));
		}
		return events;
	}

	/** `time-log` entries ("2026-10-09T09:00/2026-10-09T09:25") inside the visible range. */
	private loggedEvents(t: Task, from: string, to: string): EventInput[] {
		const log = this.app.metadataCache.getFileCache(t.file)?.frontmatter?.[FM.timeLog];
		if (!Array.isArray(log)) return [];
		const out: EventInput[] = [];
		log.forEach((entry, i) => {
			const [start, end] = String(entry).split("/");
			if (!start || !end || start.slice(0, 10) > to || end.slice(0, 10) < from) return;
			out.push({
				id: `l:${t.file.path}:${i}`,
				title: t.title,
				start,
				end,
				// Drawn as shading behind the planned blocks, so plan and reality overlap instead of squeezing each other.
				display: "background",
				classNames: ["tt-ev-log"],
				extendedProps: {
					path: t.file.path,
					kind: "logged" as EventKind,
					project: t.project?.name ?? "",
					minutes: moment(end).diff(moment(start), "minutes"),
				},
			});
		});
		return out;
	}

	private renderEvent(arg: EventContentArg): { domNodes: Node[] } {
		const kind = arg.event.extendedProps.kind as EventKind;
		if (kind === "logged") {
			const m = arg.event.extendedProps.minutes as number;
			return { domNodes: [createDiv({ cls: "tt-ev-log-label", text: `⏱ ${m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`}` })] };
		}
		const el = createDiv({ cls: "tt-ev-inner" });
		const icon = kind === "due" ? "⚑ " : "";
		if (arg.timeText && kind !== "due" && !arg.view.type.startsWith("dayGrid")) el.createDiv({ cls: "tt-ev-time", text: arg.timeText });
		el.createDiv({ cls: "tt-ev-title", text: icon + arg.event.title });
		const project = arg.event.extendedProps.project as string;
		if (project && this.projectFilter === "all" && kind === "scheduled" && !arg.event.allDay) {
			el.createDiv({ cls: "tt-ev-project", text: project });
		}
		return { domNodes: [el] };
	}

	// ---------- interactions ----------

	private task(path: string): Task | undefined {
		return this.plugin.store.getTasks().find((t) => t.file.path === path);
	}

	/** Drag (move) or stretch (resize) → write the new dates back to the note. */
	private onMove(info: EventDropArg | EventResizeDoneArg): void {
		const ev = info.event;
		const task = this.task(ev.extendedProps.path);
		if (!task || !ev.start) return info.revert();
		const kind = ev.extendedProps.kind as EventKind;

		let save: Promise<void>;
		if (kind === "due") {
			save = this.plugin.store.setDue(task.file, moment(ev.start).format("YYYY-MM-DD"));
		} else if (ev.allDay) {
			const start = moment(ev.start).format("YYYY-MM-DD");
			const lastDay = ev.end ? moment(ev.end).subtract(1, "day").format("YYYY-MM-DD") : null;
			save = this.plugin.store.setSchedule(task.file, start, lastDay && lastDay > start ? lastDay : null);
		} else {
			const start = moment(ev.start).format("YYYY-MM-DDTHH:mm");
			// Moving a block that never had an explicit end keeps it that way (length = estimate or 1h).
			const resized = "endDelta" in info;
			const end = ev.end && (resized || ev.extendedProps.hasEnd) ? moment(ev.end).format("YYYY-MM-DDTHH:mm") : null;
			save = this.plugin.store.setSchedule(task.file, start, end);
		}
		save.catch((e) => {
			info.revert();
			new Notice(`Project Pulse: ${e instanceof Error ? e.message : "save failed"}`);
		});
	}

	/** Drag across empty slots (or click a day) → New task with that schedule filled in. */
	private onSelect(info: DateSelectArg): void {
		this.calendar?.unselect();
		const project = this.plugin.store.getProjects().find((p) => p.id === this.projectFilter) ?? null;
		if (info.allDay) {
			const start = moment(info.start).format("YYYY-MM-DD");
			const last = moment(info.end).subtract(1, "day").format("YYYY-MM-DD");
			this.plugin.openNewTaskModal(project, undefined, { start, end: last > start ? last : null });
		} else {
			this.plugin.openNewTaskModal(project, undefined, {
				start: moment(info.start).format("YYYY-MM-DDTHH:mm"),
				end: moment(info.end).format("YYYY-MM-DDTHH:mm"),
			});
		}
	}

	/** Click → edit task; Ctrl/Cmd+click (or a tracked-time block) → open the note. */
	private onClick(info: EventClickArg): void {
		info.jsEvent.preventDefault();
		const task = this.task(info.event.extendedProps.path);
		if (!task) return;
		const openNote = info.jsEvent.ctrlKey || info.jsEvent.metaKey || info.event.extendedProps.kind === "logged";
		if (openNote) this.app.workspace.getLeaf(false).openFile(task.file);
		else this.plugin.openEditTaskModal(task);
	}
}
