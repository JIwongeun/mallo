# Mallo implementation contract

## Product scope

Mallo has exactly two features:

1. Show observed model, effort, task, and skill-read changes during native Codex work.
2. Summarize the observed activity when the native response ends.

Mallo reads existing local Codex transcripts. It does not add model calls, route or continue work, control execution, inject model context, keep a knowledge database, or copy native history into another event store.

## Supported delivery paths

### Codex Desktop

The selected Mallo skill reads compact, read-only snapshots through the plugin's MCP server. Progress appears in native `Show activity` MCP tool-result logs. Immediately after each worker dispatch, the skill calls `show_activity` before unrelated tools or waiting, using `focus_task` to show only the dispatched task. It passes short English display labels keyed by `main` or an exact safe native worker task label, including non-English native keys. Unknown keys cannot add rows or alter observed fields. Invalid or non-English aliases fall back to a neutral English task name without blocking reporting. An unknown, unobserved, or ambiguous focus returns observation pending. Labels are supplied by the current agent before the call; the reader neither extracts raw prompts nor persists labels. Headerless rows use `model/effort (main|sub) task [skills]`, omit the brackets when no skill reads were observed, and omit the role when native metadata lacks it. Only after work completes does the skill call `task_summary` once for the whole-task snapshot in a distinct native `Task summary` log. That native MCP tool result is authoritative; the normal assistant answer does not repeat it as a blockquote, table, code block, or footer. Legacy clients may still request summary output through `show_activity`.

Rows display `gpt-6-astra` as `GPT-6-Astra` and `gpt-5.6-sol` as `GPT-5.6-Sol`; other model IDs and raw metadata remain unchanged.

The app owns execution-row labels, icons, grouping, and expansion. Its in-progress renderer does not surface hook-run details, and MCP tool results may be collapsed. Keep Mallo calls separate from unrelated tool calls. Place the final snapshot after the substantive completion update and immediately before the final answer; a completed single-tool activity can render directly in the current Desktop renderer. This does not guarantee standalone placement for all progress logs or app views. The explicit post-dispatch snapshot provides immediate visibility without polling or duplicate commentary. Later snapshots repeat only for a meaningful read, completion, or state change in that task. Ordinary task context and output tokens cover these snapshots. No separate reporting agent or model is used.

### Codex CLI

Trusted observational hooks return only `systemMessage` or an empty object. Interactive CLI sessions show these as native warning lines, with model, effort, and skill reads associated with each task. Current `codex exec --json` event streams do not emit hook `systemMessage` events, so they cannot verify visible hook delivery. Reader or display failures fail open and never block Codex execution.

The CLI also provides explicit `sessions`, `status`, and `watch` diagnostics. The MCP tools `show_activity`, `task_summary`, and `list_activity` expose the same read-only history. `observe_activity` is reserved for native hook delivery.

No dedicated launcher, browser dashboard, HTTP server, background service, or app patch is part of the supported design.

## Reader and privacy contract

The reader:

- accepts explicit native session IDs and canonical allowed transcript roots;
- links associated parent and worker turns;
- handles partial JSONL tails and incremental refreshes;
- scopes progress and summaries to the current native turn;
- deduplicates unchanged hook observations in memory;
- never persists raw prompts, command arguments, tool results, credentials, or private reasoning.

Model and effort values are recorded metadata, not proof that a provider honored a requested route. A skill reference means a matching read request was observed, not that the skill was applied. Missing read evidence does not rule out preloaded or unrecorded use. A native response boundary does not prove project success.

## Runtime constraints

- Node.js 24 or newer, using built-in modules only.
- MCP over stdio.
- Self-contained plugin under `plugins/codex-system/`.
- Product name `Mallo`; compatibility identifier `codex-system@personal`.
- External skills, hooks, routing configuration, and native history remain unchanged.
- Tests use temporary session roots.

## Current status

- [x] Incremental transcript reader and parent/worker association.
- [x] Current-turn isolation, partial-record handling, and path containment.
- [x] Read-only MCP tools and fail-open observational hooks.
- [x] Compact Desktop progress and final native summary logs.
- [x] Interactive CLI progress and response-end warning delivery on Windows.
- [x] Native plugin and skill discovery on Windows.
- [x] Unit and transport fixture coverage.
- [ ] Independent host verification on macOS and Linux.

Successful fixture tests do not prove native discovery, hook delivery, or visible host rendering. Record those checks separately when compatibility work changes a delivery path.

## Validation

Run all repository checks:

```powershell
npm test
```

For integration changes, verify the affected native layer separately: plugin discovery, hook trust and delivery, focused MCP progress logs, final MCP summary logs, or interactive CLI rendering. Use sanitized evidence only. Never publish raw transcripts or credentials.
