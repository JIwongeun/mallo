# Mallo development

- Mallo has exactly two features: live model/effort/skill-read visibility and a completed native-turn activity summary.
- Read existing Codex transcripts directly. No additional model calls, execution controller, routing policy, knowledge database, or replicated event store. A selected native Mallo skill may ask the current task agent to read compact snapshots and include progress lines and a final summary in its existing response; this consumes normal task tokens.
- Keep the plugin self-contained under `plugins/codex-system/`. The legacy identifier stays for update compatibility; the product is Mallo.
- Use Node.js 24 built-ins and native Codex capabilities. Show compact inline activity lines, not a browser dashboard or custom card.
- Observational hooks may return only systemMessage or an empty object. Never inject model context, block, continue a task, or alter execution. Deduplicate unchanged observations in memory.
- Requested model/effort is not execution confirmation. Reading a skill is not proof of applying it. Missing read events do not prove no preloaded skill was used. Native turn completion is not independently verified project success.
- End the final answer with one fixed blockquote headed `Mallo 작업요약` and one line per observed task: task, model/effort, skill references. No legend, routine explanatory footer or summary table. Use safe native task labels; the current agent may name phases from actual work or explicit assignments, never from model identity alone. Keep per-task skill reads, concurrent work and repeated worker turns separate; do not replace them with headcounts.
- Observe only associated local session transcripts under canonical allowed roots. Unknown/partial records become coverage warnings. Never persist raw prompts, command arguments, results, credentials, or private reasoning.
- Reader/display failures must not affect Codex execution. MCP uses stdio; no HTTP server or persistent background service.
- Desktop shows checkpoint snapshots in real Mallo MCP tool-result logs through the selected skill, with a compact Markdown summary in the final answer. Avoid duplicate progress narration; use commentary only for an explicit inline request or CLI fallback. CLI retains native hook display. Report at meaningful checkpoints, not each tool. The app owns execution-row icons, labels and expansion. Do not promise skill selection or event delivery in every task. Never add a dedicated launcher, inject history, patch app binaries, change global environment variables or restart a running app.
- Preserve external skills, hooks, routing configuration, personal legacy data and Git history. Tests use temporary session roots.
- Use English instructions and machine records; Korean user-facing explanations are welcome. Keep README and docs/IMPLEMENTATION_PLAN.md concise.
- Follow the contributor's own model and workflow preferences. Mallo development does not require a particular model, routing skill or additional plugin.
- Preserve recoverable source before removal. Do not push, publish, tag, or change repository visibility without a new request.
- Verify real behavior. Distinguish fixture tests, live native discovery, hook output delivery and visible app/CLI rendering; do not infer one from another. Native systemMessage uses warning styling. Never bypass hook trust.
