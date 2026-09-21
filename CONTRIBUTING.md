# Contributing to Mallo

Thank you for helping improve Mallo. Focused bug fixes, compatibility evidence, privacy hardening, and small documentation improvements are welcome.

## Before you start

Mallo has two features: native Codex activity visibility and a completed-response activity summary. Open a feature request before work that expands this scope or adds a dependency, service, model call, execution control, or new user interface.

For bugs, search existing issues first. Include the affected Codex surface and sanitized evidence. Never post raw transcripts, prompts, command arguments, tool results, credentials, or private reasoning.

## Development setup

Requirements:

- Node.js 24 or newer
- Git
- Codex only when verifying native integration

Clone the repository and run:

```powershell
npm test
```

The project uses Node.js built-ins and has no runtime dependencies. Fixture tests use temporary session roots and need no model API key or real Codex transcript. You can also run the suite directly:

```powershell
node --test "test/*.test.mjs"
```

## Change guidelines

- Reuse existing reader, formatter, and transport paths.
- Keep hooks observational and fail open.
- Do not inject model context, block work, route models, or continue tasks.
- Keep MCP on stdio; do not add a server or background service.
- Preserve compatibility identifier `codex-system@personal`.
- Keep user output compact and preserve the fixed `Mallo 작업요약` heading.
- Add one focused test for new non-trivial logic.

## Pull requests

Keep pull requests small and explain the concrete behavior change. Report fixture checks separately from native discovery, hook delivery, and visible Desktop or CLI rendering. A passing fixture is not evidence that every native layer works.

Use sanitized fixtures and temporary paths. Update README or implementation contract when behavior, installation, or compatibility changes.

## Plugin updates

Codex caches plugins by the version in `plugins/codex-system/.codex-plugin/plugin.json`. Give each packaged update a new version before reinstalling, then verify it in a fresh task. Keep the root and packaged `LICENSE` copies identical. Updating a checkout alone does not refresh an already running task.

For releases, align the package version, plugin manifest version, and MCP server version, then tag the tested commit as `vX.Y.Z`. Publish release notes from that tag. Development builds may use a `+codex.<timestamp>` cache suffix; published tags remain immutable except for a coordinated privacy or security correction.
