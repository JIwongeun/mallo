# Mallo implementation contract

## Product scope

Mallo has exactly two features:

1. Show observed model, effort, task, and skill-read changes during native Codex work.
2. Summarize the observed activity when the native response ends.

Mallo reads existing local Codex transcripts. It does not add model calls, route or continue work, control execution, inject model context, keep a knowledge database, or copy native history into another event store.

## Supported delivery paths

### Codex Desktop

The selected Mallo skill reads snapshots through the plugin's MCP server. Progress appears in native `Show activity` tool-result logs. With `focus_task` omitted, each checkpoint includes the selected native turn and its observed worker turns, so the newest result contains activity so far. After a grouped worker dispatch, call once for the group before unrelated tools or waiting. Explicit `focus_task` remains a diagnostic filter; unknown, unobserved, or ambiguous focus returns observation pending. No earlier native tool item is modified or merged.

The current agent supplies grounded English labels keyed by `main` or exact safe native worker labels, including non-English lookup keys. Unknown keys cannot add rows or alter observed fields; invalid display aliases fall back. The reader neither extracts raw prompts nor persists labels. Each task block starts with `model/effort (main|sub) task`, followed by one `- skill` line per visible observed skill, with a blank line between blocks. Preserve all task blocks and skill names in Desktop text and explicit multiline Markdown, without `+N` or a preview cutoff. Omit skill lines when no reads were observed and omit missing roles. Mallo's own observer skill stays excluded. Keep each worker turn and its skills separate.

Only after work completes does the skill call `task_summary` once in a distinct native `Task summary` log. That result is authoritative; the normal assistant answer does not repeat it. Legacy clients may still request summary output through `show_activity`.

Human-readable activity, CLI diagnostics, and hooks display numeric GPT model IDs with the `GPT-` prefix and capitalize known codenames `Astra`, `Sol`, `Terra`, and `Luna`. Preserve version and other suffixes, unknown non-GPT IDs, and all raw JSON model metadata.

The app owns execution-row labels, icons, grouping, and expansion. Keep Mallo calls separate from unrelated tools and place progress at natural phase boundaries. Put the final snapshot after a substantive completion update and immediately before the final answer. Static inspection of Desktop 26.915.4065.0 found that a completed singleton group can render as an independent activity item, while ordinary MCP calls remain groupable. This is not a guarantee of placement or a visible rendering test. There is no supported Mallo setting to force independence, replace prior calls, or merge them into a persistent item. Never add filler commentary to split groups. Repeat snapshots only for meaningful read, completion, or participation changes. Ordinary task tokens cover the snapshots; no separate reporting model is used.

### Codex CLI

Trusted observational hooks return only `systemMessage` or an empty object. Interactive CLI sessions retain bounded one-line native warnings, with model, effort, and skill reads associated with each task. Explicit multiline output contains complete task and skill blocks. Current `codex exec --json` event streams do not emit hook `systemMessage` events, so they cannot verify visible hook delivery. Reader or display failures fail open and never block Codex execution.

Prefer native MCP checkpoints in CLI as well as Desktop. When MCP is unavailable, `status --view current --phase progress|summary` defaults to full plain text, identical to explicit `--format plain`; it contains unescaped task headers and one bullet per skill. Explicit `--format markdown` and `--json` remain available for their respective consumers. Use Node from PATH when available. Codex owns the shell command echo and output expansion; Mallo cannot hide them.

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
- Self-contained plugin under `plugins/mallo/`.
- Product name `Mallo`; install identifier `mallo@mallo`.
- External skills, hooks, routing configuration, and native history remain unchanged.
- Tests use temporary session roots.

## Current status

- [x] Incremental transcript reader and parent/worker association.
- [x] Current-turn isolation, partial-record handling, and path containment.
- [x] Read-only MCP tools and fail-open observational hooks.
- [x] Cumulative Desktop progress and final native summaries with complete skill lists.
- [x] Interactive CLI progress and response-end warning delivery on Windows.
- [x] Native plugin and skill discovery, installed MCP startup, and plain CLI output on Windows and Linux.
- [x] Unit and transport fixture coverage.
- [ ] Interactive Linux rendering and independent macOS host verification.

Successful fixture tests do not prove native discovery, hook delivery, or visible host rendering. Record those checks separately when compatibility work changes a delivery path.

## Validation

Run all repository checks:

```powershell
npm test
```

For integration changes, verify the affected native layer separately: plugin discovery, hook trust and delivery, cumulative and focused MCP progress logs, final MCP summary logs, or interactive CLI rendering. Full task/skill output and a correct call schedule do not prove that the app renders an independent item. Use sanitized evidence only. Never publish raw transcripts or credentials.

2026-09-21 validation for build `0.3.2+codex.20260921105936`: all 23 tests passed on Windows and Linux with Node 24.19.0, including consistent GPT names across activity, hooks, and CLI status/watch without changing raw model metadata. All five README output examples matched the runtime formatters. Fresh native `skills/list` calls discovered the enabled skill on both hosts. Installed MCP startup and default/plain CLI output passed isolated fixture checks; all 11 installed files matched each host's source. The Linux Node executable setting and hook definitions were preserved. An earlier Desktop build also returned cumulative activity from a live session. Linux interactive rendering and independent Desktop item placement remain unverified. Start a new task to load the updated plugin snapshot.

Release `0.3.3` repeats the 23 tests and five README example checks on Windows and Linux. Package, plugin, and MCP versions are aligned. It advances beyond the `0.3.2+codex...` development builds because native activation of the unsuffixed `0.3.2` left an older cached build active; native installation and discovery of `0.3.3` succeeded on Windows.
