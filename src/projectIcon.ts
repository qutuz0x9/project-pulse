import { getIconIds } from "obsidian";
import type { Project } from "./types";

// First match wins, so put specific words before general ones. Matched against the lowercase project name.
const KEYWORD_ICONS: [string[], string][] = [
	[["docker", "container", "kubernetes", "k8s"], "container"],
	[["github", "git "], "git-branch"],
	[["actions", "ci/cd", "ci-cd", "pipeline", "deploy"], "workflow"],
	[["redis", "cache"], "layers"],
	[["sql", "postgres", "mongo", "database", "db "], "database"],
	[["kafka", "queue", "message"], "mail"],
	[["nginx", "server", "linux", "ubuntu"], "server"],
	[["tmux", "terminal", "shell", "bash", "cli"], "terminal"],
	[["api", "rest", "graphql", "http"], "plug"],
	[["web", "html", "css", "react", "angular", "next"], "globe"],
	[["typescript", "javascript", "node", "express", "c#", "c++", "python", "code"], "code-2"],
	[["test", "quiz"], "flask-conical"],
	[["security", "auth", "jwt"], "shield"],
	[["design", "ui", "ux", "canva"], "palette"],
	[["problem", "algorithm", "leetcode", "data structure"], "puzzle"],
	[["ai", "agent", "claude", "gpt"], "bot"],
	[["interview", "career", "job"], "briefcase"],
	[["english", "language"], "languages"],
	[["book", "read"], "book-open"],
	[["study", "learn", "course"], "graduation-cap"],
];

const FALLBACK = "folder-kanban";
let known: Set<string> | null = null;

function exists(icon: string): boolean {
	known ??= new Set(getIconIds());
	return known.has(icon) || known.has(`lucide-${icon}`);
}

/** The project's own `project-icon` if it is a real icon, else a guess from its name, else a folder. */
export function projectIcon(project: Project): string {
	if (project.icon && exists(project.icon)) return project.icon;
	const name = ` ${project.name.toLowerCase()} `;
	for (const [words, icon] of KEYWORD_ICONS) {
		// Whole-word match for short words ("ai", "ui", "db") so "email" doesn't match "ai".
		if (words.some((w) => (w.length <= 3 ? new RegExp(`(?<![a-z0-9])${w.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(name) : name.includes(w)))) return icon;
	}
	return FALLBACK;
}
