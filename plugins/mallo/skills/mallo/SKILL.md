---
name: mallo
description: Show readable, read-only Codex model and task activity with complete skill-read lists. Use for explicit Mallo requests and meaningful multi-step work where cumulative checkpoints help; skip trivial chats and one-step edits.
---

# Mallo

Use Mallo as a read-only overlay alongside one development workflow. It never plans, routes, controls, blocks, or verifies the task, and it never starts another model call.

## Select the current task

Use the current native task or thread ID only when the host provides it directly to this agent. Otherwise read `CODEX_THREAD_ID` in the current agent's shell, falling back to `CODEX_SESSION_ID`. Do not read these variables inside the shared MCP server. Do not infer the current task from `list_activity`, the most recent transcript, a worker, another chat, or a remembered ID.

If no current ID is available, a lookup fails, or the compact view reports unavailable, say `Mallo · Activity unavailable` once and continue the authorized work. Never fabricate missing model, effort, skill, worker, or turn metadata.

For an explicit historical request, `list_activity` may identify the session the user requested, followed by `show_activity` without `view`. Never use that list to infer the current session.

## Report checkpoints

For a meaningful multi-step task, report at the start, at material phase changes, when worker participation materially changes, and once after all task work completes. Do not poll, narrate every tool call, or repeat unchanged output. If native CLI hook lines are already visible, skip duplicate skill narration. Each normal checkpoint includes the selected native turn and associated worker turns that started inside its time window, not the whole conversation. The newest checkpoint contains the observed activity so far; it does not replace or merge earlier native tool items.

After native worker dispatch with `spawn_agent` or `followup_task`, call `show_activity` as the next tool action, before unrelated tools or `wait_agent`. After a grouped dispatch, make one cumulative call for the group, not one call per worker. Use `phase: "progress"` and omit `focus_task`. Supply short grounded English goals for the coordinator and all known workers in `task_labels`, keyed by `main` and exact native task labels. Only recorded worker turns appear; a missing worker is not proof that it did not run. Never present a requested route as observed, poll for a missing transcript, or start a reporting worker. Repeat a checkpoint only for meaningful new reads, completion, or state changes. Do not call `task_summary` during work.

Call `show_activity` with the exact current ID, `view: "current"`, and `phase: "progress"`. Pass `turn_id` only when the host directly supplies the current native turn ID. Keep native lookup keys unchanged, even when they are not English. Use no translation service or extra model call. The native MCP tool item is the progress checkpoint; do not echo it in ordinary commentary. Set `focus_task` only when the user requests a particular task's diagnostic view. Unknown, unobserved, or ambiguous focus returns observation pending; never substitute the coordinator. An assigned model or intended skill is not an observed value.

Only after all requested work is complete, call `task_summary` once with the exact current `session_id` and, only when directly supplied by the host, `turn_id`. Before calling the tool, supply every grounded short English display alias in `task_labels`; use `main` for the coordinator and exact safe native task-label keys for workers. Keep a neutral English label when context is insufficient. Never infer a label from the model, effort, command text, or timing. Do not pass a progress phase or focused task to `task_summary`. The returned native tool result is the authoritative Mallo completion summary, including its coverage notes. Then write the normal final answer without echoing the Mallo output as a blockquote, table, code block, or routine footer. Do not add rows, results, or skills.

Keep each Mallo call separate from shell commands and unrelated tools, including inside a code-mode wrapper. Place progress calls at natural phase boundaries where substantive updates already belong. For completion, finish all checks and give the concise, substantive completion or verification update before calling `task_summary` as the last tool action, followed immediately by the normal final answer. The native titles remain `Show activity` and `Task summary`. A completed singleton activity may render independently, but the app controls grouping and expansion; do not promise forced placement, a persistent card, or merged historical calls. Do not add empty messages, duplicate Mallo lines, or filler just to split groups.

Each task block starts with `model/effort (main|sub) task`, followed by one `- skill` line per observed skill. Separate task blocks with a blank line. Show all returned task blocks and skill names without brackets, `+N`, or a preview cutoff. A block with no skill lines means only that no visible read request was observed; preloaded or unrecorded skill use may be absent. Mallo's own observer skill remains excluded. Keep each task turn and its skill attribution separate, including repeated worker turns. Omit the role when native metadata lacks it. Numeric GPT model IDs display with the `GPT-` prefix and capitalized codenames `Astra`, `Sol`, `Terra`, and `Luna`. Preserve versions and other suffixes. Unknown non-GPT IDs and raw JSON model metadata remain unchanged. The role comes from native metadata, never from a task label. Display order is not a claim of serial execution. A native turn completion label does not prove project success. Never simulate native skill badges, tool cards, or collapsible UI in response text.

If the user explicitly requests structured diagnostics, use the installed CLI current view with `--phase summary --json`. This remains the selected turn scope; do not expand it to whole-session history.

Prefer the native MCP tools in both Desktop and CLI. A terminal client alone is not a reason to use the shell fallback. If the MCP tool is unavailable, resolve `../../cli.mjs` from the directory containing this `SKILL.md` and run:

```text
node <plugin-root>/cli.mjs status --session <current-native-uuid> --view current --phase progress|summary [--turn <current-turn-uuid>] [--focus-task <exact-native-task-label>] --format plain
```

Use `node` from PATH when available; resolve an absolute Node executable only when needed. Default and `--format plain` output contain unescaped task blocks and skill bullets. Reserve `--format markdown` for an explicitly requested Markdown consumer, never a terminal checkpoint. Codex controls the shell command echo and may collapse output; Mallo cannot hide or restyle it.

Omit `--focus-task` for normal cumulative progress and final summaries; use it only for explicitly focused progress diagnostics. Use the command's existing output as the fallback checkpoint or summary. Do not fabricate a native card or duplicate the output in the assistant response. Preserve its observed task blocks and coverage notes. Do not activate hooks, install dependencies, change global configuration, or use a dedicated launcher.

Only the main coordinator reports Mallo checkpoints. Workers do not recursively run this skill unless the user explicitly requests per-worker status.

Implicit selection is best effort for meaningful multi-step tasks, not a global all-task activation guarantee. Direct `$mallo` selection remains available.
