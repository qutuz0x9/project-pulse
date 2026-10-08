import { App, Modal, moment, Notice } from "obsidian";
import { parseQuickAdd, QuickAddResult } from "./quickAdd";
import type { TaskStore } from "./store";
import { PRIORITY_LABELS, Project } from "./types";

/** One-line task entry with a live preview of what was understood. Enter = create, Shift+Enter = create & open. */
export class QuickAddModal extends Modal {
	private result: QuickAddResult | null = null;

	constructor(app: App, private store: TaskStore, private defaultProject: Project | null) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass("tt-quickadd");
		this.setTitle("Quick add task");

		const input = contentEl.createEl("input", {
			cls: "tt-quickadd-input",
			type: "text",
			attr: { placeholder: "Fix login bug tomorrow !high #backend @Project ~2h" },
		});
		const preview = contentEl.createDiv({ cls: "tt-quickadd-preview" });
		const help = contentEl.createDiv({ cls: "tt-quickadd-help" });
		for (const [code, text] of [
			["@project", "project"],
			["!high", "priority"],
			["#tag", "category"],
			["~2h", "estimate"],
			["*weekly", "repeat"],
			["tomorrow · fri · in 3d · 2026-10-20", "due"],
			["14:00-16:00 · 9am", "schedule a block"],
		]) {
			const item = help.createSpan();
			item.createEl("code", { text: code });
			item.appendText(` ${text}`);
		}
		contentEl.createDiv({ cls: "tt-quickadd-keys", text: "Enter to create · Shift+Enter to create and open" });

		const update = () => {
			this.result = parseQuickAdd(input.value, this.store.getProjects());
			if (!this.result.project && this.defaultProject) {
				this.result.project = this.defaultProject;
				this.result.errors = this.result.errors.filter((e) => !e.startsWith("No project"));
			}
			if (!this.result.project && !this.result.errors.some((e) => e.includes("project"))) {
				this.result.errors.push("Add @project");
			}
			this.renderPreview(preview, input.value.trim() === "");
		};
		input.addEventListener("input", update);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submit(e.shiftKey);
			}
		});
		update();
		window.setTimeout(() => input.focus(), 0);
	}

	private renderPreview(el: HTMLElement, empty: boolean): void {
		el.empty();
		const r = this.result;
		if (!r || empty) {
			el.createSpan({ cls: "tt-quickadd-hint", text: this.defaultProject ? `Goes to ${this.defaultProject.name} unless you add @project` : "Type a task…" });
			return;
		}
		const chip = (label: string, value: string, cls = "") => {
			const c = el.createSpan({ cls: `tt-qa-chip ${cls}`.trim() });
			c.createSpan({ cls: "tt-qa-label", text: label });
			c.createSpan({ text: value });
		};
		if (r.title) chip("Title", r.title, "is-title");
		if (r.project) chip("Project", r.project.name);
		if (r.due) chip("Due", moment(r.due).calendar(null, { sameDay: "[Today]", nextDay: "[Tomorrow]", nextWeek: "dddd", sameElse: "MMM D" }));
		if (r.scheduled) {
			const day = moment(r.scheduled).calendar(null, { sameDay: "[Today]", nextDay: "[Tomorrow]", nextWeek: "ddd", sameElse: "MMM D" });
			const range = moment(r.scheduled).format("HH:mm") + (r.scheduledEnd ? `–${moment(r.scheduledEnd).format("HH:mm")}` : "");
			chip("Scheduled", `${day} ${range}`);
		}
		if (r.priority) chip("Priority", PRIORITY_LABELS[r.priority], `is-${r.priority}`);
		if (r.estimate !== null) chip("Estimate", `${r.estimate}h`);
		if (r.repeat) chip("Repeat", r.repeat);
		for (const c of r.categories) chip("#", c);
		for (const e of r.errors) el.createSpan({ cls: "tt-qa-error", text: e });
	}

	private async submit(openAfter: boolean): Promise<void> {
		const r = this.result;
		if (!r || r.errors.length || !r.project) return void new Notice(r?.errors[0] ?? "Type a task first.");
		try {
			const file = await this.store.createTask({
				title: r.title,
				project: r.project,
				status: "todo",
				priority: r.priority ?? "medium",
				due: r.due,
				estimate: r.estimate,
				category: r.categories,
				repeat: r.repeat,
				scheduled: r.scheduled,
				scheduledEnd: r.scheduledEnd,
			});
			new Notice(`Task added to ${r.project.name}`);
			this.close();
			if (openAfter) await this.app.workspace.getLeaf(false).openFile(file);
		} catch (e) {
			new Notice(e instanceof Error ? e.message : "Failed to create task.");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
