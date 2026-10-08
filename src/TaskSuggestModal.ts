import { App, FuzzySuggestModal, moment } from "obsidian";
import { today } from "./store";
import type { Task } from "./types";

/** Searchable list of open tasks (type to filter by title or project). */
export class TaskSuggestModal extends FuzzySuggestModal<Task> {
	constructor(app: App, private tasks: Task[], private onChoose: (t: Task) => void, placeholder = "Search open tasks…") {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): Task[] {
		return this.tasks;
	}

	getItemText(t: Task): string {
		return `${t.title} ${t.project?.name ?? ""}`;
	}

	renderSuggestion(match: { item: Task }, el: HTMLElement): void {
		const t = match.item;
		el.addClass("tt-suggest");
		el.createSpan({ cls: `tt-dot tt-prio-dot-${t.priority}` });
		const text = el.createDiv({ cls: "tt-suggest-text" });
		text.createDiv({ text: `${t.status === "in-progress" ? "● " : ""}${t.title}` });
		text.createDiv({ cls: "tt-suggest-sub", text: [t.project?.name ?? "No project", t.due ? `due ${dueText(t.due)}` : ""].filter(Boolean).join(" · ") });
	}

	onChooseItem(t: Task): void {
		this.onChoose(t);
	}
}

function dueText(due: string): string {
	const days = moment(due).diff(moment(today()), "days");
	if (days === 0) return "Today";
	if (days === 1) return "Tomorrow";
	if (days === -1) return "Yesterday";
	return moment(due).format("MMM D");
}
