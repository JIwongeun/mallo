---
name: codex-system
description: In an outer Codex session, route implementation, fixes, planning, and verification in a registered local project through the installed Codex System pipeline. Use when the session hook says the cwd is registered or the user explicitly asks. Never use when a prompt says CODEX_SYSTEM_WORKER=1. Skip informational questions and unmanaged directories.
---

# Codex System

Use the installed runner once for the user's project task. Do not implement the same task in the outer chat.

1. Stop if `CODEX_SYSTEM_MANAGED_RUN=1`; this is already a worker context.
2. Use the current cwd from the session. Never infer a sibling project or substitute the hub.
3. Call `mcp__codex_system__start_managed_task` once with the absolute current cwd, the exact user message in `original_request`, the project task in `request`, and any explicitly requested skill identifiers in `explicit_skills`. Remove only the explicit skill-selection phrase from `request`; preserve every project requirement. This bridge is required because a child-only workspace cannot write the hub's runtime state through its shell sandbox.
4. Call `mcp__codex_system__await_managed_task` with the returned run ID, `timeout_ms: 30000`, and the last observed state revision in `after_revision` until the state is terminal or `needs_input`. Relay only new meaningful progress without modifying project files or running the hub CLI through a shell.
5. If a `needs_input` state has a `pending_request`, ask the recorded question and, only after the user's next answer, call `mcp__codex_system__respond_managed_task` with its exact run/request IDs and actual response payload. If the outcome instead contains planning questions, ask them and start one revised request after the answer. Never invent an answer or approval. Use `mcp__codex_system__cancel_managed_task` only when the user cancels.
6. Report the run ID, route, checks, criterion verdicts, and actual terminal status. Never convert unknown, blocked, failed, or cancelled into success.

For diagnosis, explicit invocation must use the same runner and binding path as implicit use.
