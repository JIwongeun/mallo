---
name: mallo
description: Show a compact, read-only view of the current native Codex model, effort, skill-read evidence, task turns, and turn state. Use for explicit Mallo requests and meaningful multi-step work where checkpoint visibility helps; skip trivial chats and one-step edits.
---

# Mallo

Use Mallo as a read-only overlay alongside one development workflow. It never plans, routes, controls, blocks, or verifies the task, and it never starts another model call.

## Select the current task

Use the current native task or thread ID only when the host provides it directly to this agent. Otherwise read `CODEX_THREAD_ID` in the current agent's shell, falling back to `CODEX_SESSION_ID`. Do not read these variables inside the shared MCP server. Do not infer the current task from `list_activity`, the most recent transcript, a worker, another chat, or a remembered ID.

If no current ID is available, a lookup fails, or the compact view reports unavailable, say `Mallo · Activity unavailable` once and continue the authorized work. Never fabricate missing model, effort, skill, worker, or turn metadata.

For an explicit historical request, `list_activity` may identify the session the user requested, followed by `show_activity` without `view`. Never use that list to infer the current session.

## Report checkpoints

For a meaningful multi-step task, report at the start, at material phase changes, when worker participation materially changes, and once after all task work completes. Do not poll, narrate every tool call, or repeat an unchanged line. If native CLI hook lines are already visible, skip duplicate skill narration. The compact scope is the selected native turn plus every associated worker turn that started inside that turn's time window, not the whole conversation. Selecting a worker task shows only that worker turn.

After every native worker dispatch with `spawn_agent` or `followup_task`, call `show_activity` as the next tool action, before unrelated tools or `wait_agent`. After a grouped dispatch, call one focused checkpoint per dispatched task immediately after the group. Use `phase: "progress"`, set `focus_task` to the exact dispatched `task_name` or native `agent_path` leaf, and pass its short English task goal in `task_labels`. Use `main` for the coordinator. A progress checkpoint shows only that focused task. If its native transcript is not available yet, preserve the observation-pending result; never fall back to the coordinator or present a requested route as observed. Repeat a progress checkpoint only when that task gains a skill-read record, completes, or has another meaningful state change. Never start a reporting worker, poll for Mallo, or request the whole-task summary during work.

Call `show_activity` with the exact current ID, `view: "current"`, and `phase: "progress"`. Pass `turn_id` only when the host directly supplies the current native turn ID. Before every call, supply a short grounded English label for the focused task, including `main`, even when the conversation is in another language. Use no translation service or extra model call. The native MCP tool item is the progress checkpoint; do not echo it in ordinary commentary. The checkpoint lists only native values observed for the focused task. An assigned model or intended skill is not an observed value. The host controls the tool item's title, icon, grouping, and expansion, so do not promise a custom card or live-streaming panel.

Only after all requested work is complete, call `task_summary` once with the exact current `session_id` and, only when directly supplied by the host, `turn_id`. This is the only whole-task snapshot. Before calling the tool, supply every grounded short English display alias in `task_labels`; use `main` for the coordinator and exact safe native task-label keys for workers, including keys written in another language. Keep a neutral English label when context is insufficient. Never infer a label from the model, effort, command text, or timing. Do not pass a progress phase or focused task to `task_summary`. The returned `Task summary` native MCP tool result is the authoritative Mallo completion summary, including any omitted-count or coverage note. Then write the normal final answer without echoing the Mallo output as a blockquote, table, code block, or routine footer. Do not add rows, results, or skills.

Keep each Mallo call separate from shell commands and unrelated tools, including inside a code-mode wrapper. For completion, finish all checks and give the concise, substantive completion or verification update before calling `task_summary` as the last tool action, followed immediately by the normal final answer. The native tool title is `Task summary`, distinct from progress `Show activity`; the app controls grouping and expansion. Do not add empty messages, duplicate Mallo lines, or filler just to split groups.

Use each row's own skill-read evidence. A row without bracketed skills means only that no read request was observed; it does not mean no skill was used, and context-dependent or preloaded skill use may be absent. Headerless rows use `model/effort (main|sub) task [skill1, skill2]`, omit brackets when no reads were observed, and omit the role when native metadata lacks it. Exact model IDs `gpt-6-astra` and `gpt-5.6-sol` display as `GPT-6-Astra` and `GPT-5.6-Sol`; other IDs remain unchanged. The role comes from native metadata, never from a task label. Display order is not a claim of serial execution. A native turn completion label describes transcript evidence only; it does not prove project success or verification. Never simulate native skill badges, tool cards, or collapsible UI in response text.

If the user explicitly asks for the full task record after a bounded preview, use the installed CLI current view with `--phase summary --json`. Return the native diagnostic tool or command output without imposing a blockquote format. This remains the selected turn scope; do not expand it to whole-session history.

If the MCP tool is unavailable, resolve `../../cli.mjs` from the directory containing this `SKILL.md` and run:

```text
node <plugin-root>/cli.mjs status --session <current-native-uuid> --view current --phase progress|summary [--turn <current-turn-uuid>] [--focus-task <exact-native-task-label>] --format markdown
```

For worker progress, pass the same exact `focus_task`; omit it for the final summary. Use the command's existing output as the fallback checkpoint or summary. Do not fabricate a native card or duplicate the output in the assistant response. Preserve its observed model, effort, skill rows, and omitted counts. Do not activate hooks, install dependencies, change global configuration, or use a dedicated launcher.

Only the main coordinator reports Mallo checkpoints. Workers do not recursively run this skill unless the user explicitly requests per-worker status.

Implicit selection is best effort for meaningful multi-step tasks, not a global all-task activation guarantee. Direct `$mallo` selection remains available.
