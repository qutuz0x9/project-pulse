import { moment, normalizePath, Notice } from "obsidian";
import type ProjectPulsePlugin from "./main";
import { FM, isClosed, Task } from "./types";

/**
 * Writes "<reviews folder>/Weekly Review <first day>.md" for this week (offset 0) or last week (-1)
 * and opens it. An existing review is opened as-is — delete it to regenerate.
 */
export async function createWeeklyReview(plugin: ProjectPulsePlugin, weekOffset: 0 | -1): Promise<void> {
	const { app } = plugin;
	const start = moment().add(weekOffset, "weeks").startOf("week");
	const end = start.clone().endOf("week");
	const from = start.format("YYYY-MM-DD");
	const to = end.format("YYYY-MM-DD");

	const folder = normalizePath(plugin.settings.reviewsFolder);
	const path = normalizePath(`${folder}/Weekly Review ${from}.md`);
	const existing = app.vault.getFileByPath(path);
	if (existing) {
		await app.workspace.getLeaf(false).openFile(existing);
		new Notice("This week's review already exists — delete it to regenerate.");
		return;
	}

	const content = buildReview(plugin, from, to, start.format("MMM D"), end.format("MMM D, YYYY"));
	await ensureFolder(plugin, folder);
	const file = await app.vault.create(path, content);
	await app.workspace.getLeaf(false).openFile(file);
}

function buildReview(plugin: ProjectPulsePlugin, from: string, to: string, fromLabel: string, toLabel: string): string {
	const tasks = plugin.store.getTasks();
	const inWeek = (d: string | null) => d !== null && d >= from && d <= to;

	const done = tasks.filter((t) => t.status === "done" && inWeek(t.completed));
	const failed = tasks.filter((t) => t.status === "failed" && inWeek(t.completed));
	const created = tasks.filter((t) => inWeek(t.created));
	const sessions = plugin.settings.pomodoroSessions.filter((s) => inWeek(s.start.slice(0, 10)));
	const pomodoros = sessions.filter((s) => s.completed).length;
	const tracked = trackedHours(plugin, tasks, from, to);
	const todayStr = moment().format("YYYY-MM-DD");
	const overdue = tasks.filter((t) => !isClosed(t.status) && t.due !== null && t.due < todayStr);
	const nextFrom = moment(to).add(1, "day").format("YYYY-MM-DD");
	const nextTo = moment(to).add(7, "days").format("YYYY-MM-DD");
	const nextWeek = tasks
		.filter((t) => !isClosed(t.status) && t.due !== null && t.due >= nextFrom && t.due <= nextTo)
		.sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));

	const link = (t: Task) => `[[${t.file.basename}]]`;
	const L: string[] = [];
	L.push("---", "tags:", "  - type/summary", `from: ${from}`, `to: ${to}`, "---", "");
	L.push(`# Weekly review · ${fromLabel} – ${toLabel}`, "");

	L.push("## At a glance", "", "| | |", "|---|---|");
	L.push(`| ✅ Done | ${done.length} |`);
	L.push(`| ❌ Failed | ${failed.length} |`);
	L.push(`| ➕ Created | ${created.length} |`);
	L.push(`| ⏱ Time tracked | ${round1(tracked)}h |`);
	L.push(`| 🍅 Pomodoros | ${pomodoros} (${minutes(sessions.reduce((a, s) => a + s.minutes, 0))} focus) |`);
	L.push(`| ⚠️ Overdue now | ${overdue.length} |`, "");

	L.push("## ✅ Completed", "");
	if (done.length === 0) L.push("_Nothing completed this week._", "");
	for (const [project, list] of groupByProject(done)) {
		L.push(`### ${project}`);
		for (const t of list) L.push(`- ${link(t)}${timeNote(t)}`);
		L.push("");
	}

	if (failed.length) {
		L.push("## ❌ Failed", "");
		for (const t of failed) L.push(`- ${link(t)}${t.project ? ` · ${t.project.name}` : ""}`);
		L.push("");
	}

	// Estimate accuracy over tasks closed this week that had an estimate.
	const estimated = [...done, ...failed].filter((t) => t.estimate);
	L.push("## 🎯 Estimate accuracy", "");
	if (estimated.length === 0) {
		L.push("_No closed tasks with an estimate this week._", "");
	} else {
		const est = estimated.reduce((a, t) => a + (t.estimate ?? 0), 0);
		const spent = estimated.reduce((a, t) => a + t.spent, 0);
		const diff = est ? Math.round(((spent - est) / est) * 100) : 0;
		L.push(
			`Estimated **${round1(est)}h**, spent **${round1(spent)}h** — ` +
				(diff === 0 ? "spot on." : diff > 0 ? `**${diff}% over** the estimate.` : `**${-diff}% under** the estimate.`),
			""
		);
		const misses = estimated
			.map((t) => ({ t, miss: t.spent - (t.estimate ?? 0) }))
			.filter((x) => Math.abs(x.miss) >= 0.5)
			.sort((a, b) => Math.abs(b.miss) - Math.abs(a.miss))
			.slice(0, 3);
		if (misses.length) {
			L.push("Biggest misses:");
			for (const { t, miss } of misses) L.push(`- ${link(t)} — estimated ${t.estimate}h, spent ${t.spent}h (${miss > 0 ? "+" : ""}${round1(miss)}h)`);
			L.push("");
		}
	}

	if (sessions.length) {
		L.push("## 🍅 Focus by task", "");
		const byTask = new Map<string, number>();
		for (const s of sessions) byTask.set(s.title, (byTask.get(s.title) ?? 0) + s.minutes);
		for (const [title, m] of [...byTask].sort((a, b) => b[1] - a[1]).slice(0, 8)) L.push(`- [[${title}]] — ${minutes(m)}`);
		L.push("");
	}

	L.push("## 📅 Due next week", "");
	if (nextWeek.length === 0) L.push("_Nothing due next week._");
	for (const t of nextWeek) L.push(`- ${link(t)} — ${moment(t.due).format("ddd MMM D")}${t.project ? ` · ${t.project.name}` : ""}`);
	L.push("");

	if (overdue.length) {
		L.push("## ⚠️ Still overdue", "");
		for (const t of overdue) L.push(`- ${link(t)} — was due ${moment(t.due).format("MMM D")}${t.project ? ` · ${t.project.name}` : ""}`);
		L.push("");
	}

	L.push("## 💭 Reflection", "", "### What went well?", "", "", "### What didn't?", "", "", "### Focus for next week", "", "");
	return L.join("\n");
}

/** Hours from every task's `time-log` entries ("start/end") that started inside the week. */
function trackedHours(plugin: ProjectPulsePlugin, tasks: Task[], from: string, to: string): number {
	let hours = 0;
	for (const t of tasks) {
		const log = plugin.app.metadataCache.getFileCache(t.file)?.frontmatter?.[FM.timeLog];
		if (!Array.isArray(log)) continue;
		for (const entry of log) {
			const [s, e] = String(entry).split("/");
			const day = s?.slice(0, 10);
			if (!day || day < from || day > to || !e) continue;
			const h = moment(e).diff(moment(s), "minutes") / 60;
			if (h > 0) hours += h;
		}
	}
	return hours;
}

function groupByProject(tasks: Task[]): [string, Task[]][] {
	const map = new Map<string, Task[]>();
	for (const t of tasks) {
		const key = t.project?.name ?? "No project";
		map.set(key, [...(map.get(key) ?? []), t]);
	}
	return [...map].sort((a, b) => a[0].localeCompare(b[0]));
}

function timeNote(t: Task): string {
	if (t.estimate) return ` — est ${t.estimate}h · spent ${t.spent}h`;
	return t.spent ? ` — spent ${t.spent}h` : "";
}

async function ensureFolder(plugin: ProjectPulsePlugin, folder: string): Promise<void> {
	// Create each missing level, e.g. "Project Pulse" then "Project Pulse/Reviews".
	const parts = folder.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const p = parts.slice(0, i).join("/");
		if (!plugin.app.vault.getAbstractFileByPath(p)) await plugin.app.vault.createFolder(p);
	}
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
