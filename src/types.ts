import { TFile } from "obsidian";

export const TASK_TAG = "type/task";

export const STATUSES = ["todo", "in-progress", "done", "failed"] as const;
export type TaskStatus = (typeof STATUSES)[number];

/** Done and Failed are "closed": not open, never overdue, and they get a `completed` (closed) date. */
export const isClosed = (status: TaskStatus): boolean => status === "done" || status === "failed";

export const PRIORITIES = ["low", "medium", "high"] as const;
export type TaskPriority = (typeof PRIORITIES)[number];

// Sort order: high first.
export const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

export const STATUS_LABELS: Record<TaskStatus, string> = {
	todo: "Todo",
	"in-progress": "In Progress",
	done: "Done",
	failed: "Failed",
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
	low: "Low",
	medium: "Medium",
	high: "High",
};

// Frontmatter keys written to each task note.
// `task-status` (not `status`) because the vault already uses `status` for learning state.
export const FM = {
	trackerProject: "tracker-project", // on project notes: the project's display name
	project: "project",
	status: "task-status",
	priority: "priority",
	due: "due",
	created: "created",
	completed: "completed", // date the task was closed (done or failed)
	estimate: "estimate",
	spent: "spent",
	category: "category",
	timeLog: "time-log",
	pomodoros: "pomodoros", // finished focus sessions
	repeat: "repeat", // e.g. "weekly" — closing the task creates the next one
	next: "next", // on a closed recurring task: link to the copy it created
	blockedBy: "blocked-by", // links to tasks that must be closed first
	scheduled: "scheduled", // when you plan to work on it: "2026-10-09" (all day) or "2026-10-09T14:00"
	scheduledEnd: "scheduled-end", // end of that block, same format (a date = last all-day day, inclusive)
} as const;

export interface Project {
	id: string; // the project note's path — unique, used for filters
	name: string; // display name from `tracker-project`, e.g. "Food Delivery Clone"
	folder: string; // folder of the project note; its tasks go in <folder>/Tasks/
	file: TFile; // the project note (any note with a `tracker-project` property)
}

export interface Task {
	file: TFile;
	title: string;
	project: Project | null;
	status: TaskStatus;
	priority: TaskPriority;
	due: string | null; // YYYY-MM-DD
	created: string | null;
	completed: string | null;
	estimate: number | null; // hours
	spent: number; // hours
	pomodoros: number; // finished focus sessions
	category: string[];
	checklist: { done: number; total: number } | null; // `- [ ]` boxes in the note body
	repeat: string | null; // raw `repeat` value, e.g. "weekly"
	scheduled: string | null; // "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"
	scheduledEnd: string | null; // same format
	blockedByPaths: string[]; // resolved note paths of blockers
	blockers: Task[]; // blocker tasks that are still open
}

/** Blocked = at least one task in `blocked-by` is still open. */
export const isBlocked = (t: Task): boolean => t.blockers.length > 0;

export interface NewTaskInput {
	title: string;
	project: Project;
	status: TaskStatus;
	priority: TaskPriority;
	due: string | null;
	estimate: number | null;
	category: string[];
	repeat?: string | null;
	blockedBy?: string[]; // note paths
	scheduled?: string | null;
	scheduledEnd?: string | null;
}
