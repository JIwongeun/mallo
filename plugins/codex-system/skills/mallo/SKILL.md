---
name: mallo
description: Route implementation, fixes, planning, and verification in the current local folder through Mallo's Astra/Sol workflow. Use when the session hook says Mallo is available or the user explicitly asks. Skip informational questions and stop in managed worker contexts.
---

# Mallo

Start one managed run for the user's project task. Do not implement the same task in the outer chat.

1. Stop when `CODEX_SYSTEM_MANAGED_RUN=1`; Mallo already owns this worker.
2. Use the current task folder exactly. Never infer a parent, sibling, or remembered project.
3. Call `mcp__mallo__start_managed_task` once with the absolute current folder, the exact user message in `original_request`, the project task in `request`, and any explicitly requested skill IDs in `explicit_skills`.
4. Poll `mcp__mallo__await_managed_task` with the run ID, `timeout_ms: 30000`, and the latest revision. Report only unseen factual progress.
5. For `needs_input`, ask the recorded question. Forward only the user's actual answer through `mcp__mallo__respond_managed_task`. Cancel only when the user asks.
6. Report the release ID, route, checks, criterion verdicts, Knowledge result, and true terminal status. Unknown, blocked, failed, and cancelled are not success.

Explicit diagnosis uses the same managed entry path as ordinary invocation.
