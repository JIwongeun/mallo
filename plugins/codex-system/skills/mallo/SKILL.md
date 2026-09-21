---
name: mallo
description: Show a compact, read-only view of the current native Codex model, effort, skill-read evidence, task turns, and turn state. Use for explicit Mallo requests and meaningful multi-step work where checkpoint visibility helps; skip trivial chats and one-step edits.
---

# Mallo

Use Mallo as a read-only overlay alongside one development workflow. It never plans, routes, controls, blocks, or verifies the task, and it never starts another model call.

## Select the current task

Use the current native task or thread ID only when the host provides it directly to this agent. Otherwise read `CODEX_THREAD_ID` in the current agent's shell, falling back to `CODEX_SESSION_ID`. Do not read these variables inside the shared MCP server. Do not infer the current task from `list_activity`, the most recent transcript, a worker, another chat, or a remembered ID.

If no current ID is available, a lookup fails, or the compact view reports unavailable, say `Mallo · 관찰 불가` once and continue the authorized work. Never fabricate missing model, effort, skill, worker, or turn metadata.

For an explicit historical request, `list_activity` may identify the session the user requested, followed by `show_activity` without `view`. Never use that list to infer the current session.

## Report checkpoints

For a meaningful multi-step task, report at the start, at material phase changes, when worker participation materially changes, and in the final response. Do not poll, narrate every tool call, or repeat an unchanged line. If native CLI hook lines are already visible, skip duplicate skill narration. The compact scope is the selected native turn plus every associated worker turn that started inside that turn's time window, not the whole conversation. Selecting a worker task shows only that worker turn.

Call `show_activity` with the exact current ID, `view: "current"`, and `phase: "progress"`. Pass `turn_id` only when the host directly supplies the current native turn ID. The native MCP tool item is the progress checkpoint; do not paste its result into ordinary commentary. The user can expand the Mallo activity tool item to inspect its organized text. The host controls its collapsed title, icon, grouping, and whether it stays expanded, so do not promise a custom card or live-streaming panel.

At the end, call the same compact view with `phase: "summary"`. End the final response with this fixed blockquote; place no content after it:

```text
> **Mallo 작업요약**
>
> <one returned native task turn per line>
```

Keep the heading unchanged. Show only the heading and task lines in the normal summary: no legend, column labels, or routine explanatory footer. Keep any necessary omitted-count or incomplete-coverage note inside the same blockquote. Use two trailing spaces between task lines so they render separately. Do not use a table or add an expanded alternative format. Preserve every observed model and effort value. Keep the returned neutral task label when context is insufficient. You may replace a neutral or native task label with a concise user-facing phase name only when the same task's explicit plan, the coordinator's own performed work, or the actual delegated assignment establishes that name. Never infer a phase from the model, effort, command text, or timing. A delegation's requested route is not execution confirmation. Do not add rows, results, or skills.

Use each row's own skill-read evidence. `읽기 기록 없음` means only that no read request was observed; it does not mean no skill was used, and context-dependent or preloaded skill use may be absent. Display order is not a claim of serial execution. These are interpretation rules, not text to append to the summary. A native turn completion label describes transcript evidence only; it does not prove project success or verification. Respect any explicit omitted count in the compact view. Never simulate native skill badges, tool cards, or collapsible UI in response text.

If the user explicitly asks for the full task record after a bounded preview, use the installed CLI current view with `--phase summary --json`. Render every `steps` entry and every skill in each entry in the same blockquote format without the preview cap. This remains the selected turn scope; do not expand it to whole-session history.

If the MCP tool is unavailable, resolve `../../cli.mjs` from the directory containing this `SKILL.md` and run:

```text
node <plugin-root>/cli.mjs status --session <current-native-uuid> --view current --phase progress|summary [--turn <current-turn-uuid>] --format markdown
```

Use the CLI Markdown output as the same checkpoint or final blockquote source. Apply only the grounded task-label replacement allowed above; preserve its observed model, effort, skill rows, and omitted counts. Do not activate hooks, install dependencies, change global configuration, or use a dedicated launcher.

Only the main coordinator reports Mallo checkpoints. Workers do not recursively run this skill unless the user explicitly requests per-worker status.

Implicit selection is best effort for meaningful multi-step tasks, not a global all-task activation guarantee. Direct `$mallo` selection remains available.
