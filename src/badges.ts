import { repeatLabel } from "./recurrence";
import { isBlocked, Task } from "./types";

/**
 * Small indicators shown next to a task everywhere it appears:
 * 🔒 blocked (with blocker names on hover), ☑ checklist progress, 🔁 repeat rule.
 * Returns true if anything was added.
 */
export function taskBadges(parent: HTMLElement, task: Task): boolean {
	let added = false;
	if (isBlocked(task)) {
		parent.createSpan({
			cls: "tt-badge-mini is-blocked",
			text: `🔒 Blocked`,
			attr: { "aria-label": `Waiting for: ${task.blockers.map((b) => b.title).join(", ")}` },
		});
		added = true;
	}
	if (task.checklist) {
		const { done, total } = task.checklist;
		const el = parent.createSpan({
			cls: `tt-badge-mini tt-checklist${done === total ? " is-complete" : ""}`,
			attr: { "aria-label": `Checklist: ${done} of ${total} done` },
		});
		el.createSpan({ text: `☑ ${done}/${total}` });
		el.createSpan({ cls: "tt-checklist-bar" }).createSpan({ cls: "tt-checklist-fill" }).setCssProps({ "--tt-pct": `${Math.round((done / total) * 100)}%` });
		added = true;
	}
	if (task.repeat) {
		parent.createSpan({ cls: "tt-badge-mini", text: `🔁 ${repeatLabel(task.repeat)}`, attr: { "aria-label": "Repeats" } });
		added = true;
	}
	return added;
}
