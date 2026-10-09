# Project Pulse

**Projects and tasks as plain notes — with a dashboard, Kanban board, calendar, Today view, Pomodoro timer and progress analytics, all inside Obsidian.**

Every task is a normal Markdown note with properties, so your tasks stay searchable, linkable and yours. Project Pulse reads those notes live and gives you views to plan, focus and see your progress.

<!--
Screenshots — add PNGs to docs/screenshots/ and uncomment:
![Today view](docs/screenshots/today.png)
![Dashboard](docs/screenshots/dashboard.png)
![Board](docs/screenshots/board.png)
![Calendar](docs/screenshots/calendar.png)
![Pomodoro](docs/screenshots/pomodoro.png)
-->

## Features

- **Projects** — any note can be a project (one property). Tasks live next to it in a `Tasks/` folder.
- **Today** — what's overdue, due today, in progress and coming up; an **Up next** pick with the reason; planned hours vs your daily budget; today's schedule; a 7-day strip; tick checklist steps inline; sort and filter.
- **Task list** — search, filter by project / status / priority / category, group by due date, project, status or priority, click column headers to sort.
- **Board** — Kanban columns (Todo, In Progress, Done, Failed); drag cards to change status.
- **Calendar** — year, month, week, 3-day, day and list views. Drag to reschedule, stretch to resize, drag across empty time to create a task. Shows due dates and the time you actually tracked.
- **Dashboard** — progress, overdue and due-soon lists, a per-project table, tasks by status over time, a planned-vs-actual burndown, breakdowns by priority and category, estimate vs actual hours.
- **Focus** — a ▶ timer and a **Pomodoro** panel (focus/break, ±1 min, sound and notifications). Time is logged on the task; **Pomodoro statistics** show streaks, focus per day and per task.
- **Quick add** — one line: `Fix login bug tomorrow !high #backend @Website ~2h *weekly`.
- **Recurring tasks** — closing a task with `repeat` creates the next one, checklist reset.
- **Blocked by** — tasks wait (🔒) until the tasks they depend on are closed.
- **Checklists** — `- [ ]` steps in a task note show as progress (☑ 2/5).
- **Weekly review** — generates a review note: done, failed, estimate accuracy, focus, what's next.
- **Embed anywhere** — a `project-pulse` code block shows tasks, Today, stats or a Pomodoro timer inside any note.

## Getting started

1. **Create a project:** Command palette → **Project Pulse: New project**, or open any note and run **Project Pulse: Mark current note as project**.
2. **Add tasks:** **Project Pulse: New task**, or **Project Pulse: Quick add task**.
3. Open **Today** from the sidebar to see what to do now.

## How tasks are stored

A project is any note with the project property:

```yaml
tracker-project: Website Redesign
```

A task is a note (by default in `<project folder>/Tasks/`) tagged with the task tag:

```yaml
---
tags:
  - type/task
project: "[[Website Redesign]]"
task-status: todo          # todo | in-progress | done | failed
priority: medium           # low | medium | high
due: 2026-10-20
created: 2026-10-09
completed: ""              # set automatically when done or failed
estimate: 2                # hours
spent: 0                   # hours, logged by the timer / Pomodoro
category:
  - backend
# optional
scheduled: 2026-10-10T09:00
scheduled-end: 2026-10-10T11:00
repeat: weekly             # daily | weekdays | weekly | monthly | "every 3 days"
blocked-by:
  - "[[Another task]]"
---

## Notes

- [ ] A checklist step
```

The tag (`type/task`), the status property (`task-status`) and the project property (`tracker-project`) can be renamed in **Settings → Project Pulse → Note format** to fit your vault's conventions.

## Quick add syntax

| Write | Means |
|---|---|
| `@Project` | project — full name or a unique start of it |
| `!high` `!m` `!l` | priority |
| `#tag` | category (repeatable) |
| `~2h` `~30m` | estimate |
| `*daily` `*weekdays` `*weekly` `*monthly` | repeat |
| `today` `tomorrow` `fri` `in 3d` `in 2w` `2026-10-20` | due date |
| `14:00-16:00` `9am` `2:30pm-4pm` | schedule a calendar block (the date word then means *when*, not *due*) |

Everything else becomes the title. A live preview shows what was understood before you press Enter.

## Embedding in notes

````markdown
```project-pulse
view: today
limit: 8
```
````

All options are optional, one per line:

| Option | Values |
|---|---|
| `view` | `tasks` (default), `today`, `stats`, `pomodoro` |
| `project` | a project name — defaults to the note's own project, otherwise all projects |
| `show` | `open` (default) or `all` — tasks view |
| `limit` | max tasks listed — tasks and today views |

## Commands

New task · Quick add task · Edit current task · Delete current task · New project · Mark current note as project · Remove current note from projects · Open Today · Open task list · Open board · Open calendar · Open dashboard · Open Pomodoro · Open Pomodoro statistics · Start Pomodoro for current task · Stop Pomodoro · Start/stop timer for current task · Stop timer · Create weekly review (this week / last week)

## Settings

- **Note format** — task tag, status property, project property.
- **Sidebar icons** — choose which views get a sidebar icon (all views also have commands).
- **Folders** — where new projects, task notes and weekly reviews go.
- **Daily budget** — hours of work you plan per day (Today view).
- **Pomodoro** — focus / short break / long break lengths, long break interval, sound, system notification.

## Privacy

Project Pulse works entirely offline. It makes **no network requests** and collects nothing. Tasks live in your notes; settings, the running timer and the Pomodoro history are stored in the plugin's `data.json` inside your vault.

## Installation

- **Community plugins** (once approved): Settings → Community plugins → Browse → search "Project Pulse".
- **Beta via BRAT:** install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, then "Add beta plugin" with this repository's URL.
- **Manual:** download `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/project-pulse/`, then enable the plugin.

## Development

```bash
npm install
npm run dev     # rebuild on change
npm run build   # type-check + production build (main.js at the repo root)
```

Releases: bump `version` in `manifest.json` / `package.json`, add it to `versions.json`, commit, then push a matching tag (`git tag -a 1.0.1 -m "1.0.1" && git push origin 1.0.1`). The GitHub workflow builds and creates a draft release.

## Credits

Built with [Chart.js](https://www.chartjs.org) and [FullCalendar](https://fullcalendar.io), both MIT-licensed — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## License

[MIT](LICENSE)
