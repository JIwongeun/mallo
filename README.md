<div align="center">
  <img src="plugins/codex-system/assets/mallo.png" width="110" alt="Mallo mascot">
  <h1>Mallo</h1>
  <p><strong>See which models and skills helped with your Codex work.</strong></p>
  <p>
    <a href="https://github.com/JIwongeun/mallo/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/JIwongeun/mallo/actions/workflows/ci.yml/badge.svg"></a>
    <img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-F59E0B">
    <img alt="Codex plugin" src="https://img.shields.io/badge/Codex-plugin-111827">
    <img alt="Node.js 24 or newer" src="https://img.shields.io/badge/Node.js-%3E%3D24-339933">
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2563EB">
  </p>
  <p><a href="#install">Install</a> · <a href="#output">Preview</a> · <a href="CONTRIBUTING.md">Contribute</a> · <a href="SECURITY.md">Security</a></p>
</div>

Mallo is a local, read-only activity observer for Codex. It has two features:

1. **Live visibility** into observed model, effort, task, and skill-read changes.
2. **A completion summary** of the native activity observed for the response.

Mallo reads existing Codex transcripts with deterministic Node.js code. It does not call another model, route work, control execution, or maintain a separate history database.

## Output

In Codex Desktop, the selected Mallo skill writes checkpoints to native MCP tool-result logs and ends the answer with a compact summary:

> **Mallo 작업요약**
>
> 요구사항 정리 · Astra/high · model-reasoning-router\
> 구현 · Sol/high · 읽기 기록 없음

The Korean heading and row format above match current runtime output. In the interactive CLI, trusted hooks show native warning lines instead.

Model and effort values reflect recorded native metadata. A skill name means Mallo observed a matching read request; it does not prove the skill was followed. Missing read evidence does not prove that no preloaded skill was used.

## Install

Requirements:

- Node.js 24 or newer
- Codex Desktop or Codex CLI with plugin support
- The `codex` command on `PATH` for the installation commands below
- Read access to this repository while it is private

Install from a source checkout:

```powershell
git clone https://github.com/JIwongeun/mallo.git
cd mallo
codex plugin marketplace add .
codex plugin add codex-system@personal
```

The marketplace name is currently `personal`, and the compatibility identifier remains `codex-system@personal`. Check `codex plugin list --json` first if you already use a marketplace with that name.

Then:

1. Open a new Codex task so it loads the plugin snapshot.
2. Use `/hooks` to review and trust the Mallo hooks.
3. Select `$mallo` when you want explicit Desktop checkpoints and the final summary.

Mallo never changes hook trust. Skill selection and event delivery remain native Codex behavior, so they are not guaranteed for every task.

## Update

Update the checkout, then reinstall the existing compatibility identifier:

```powershell
git pull --ff-only
codex plugin add codex-system@personal
```

Open a fresh Codex task after updating. Mallo is distributed from source; no npm package is published.

## Diagnostics

Use an explicit native session ID:

```powershell
node plugins/codex-system/cli.mjs sessions --json
node plugins/codex-system/cli.mjs status --session your_session_id_here
node plugins/codex-system/cli.mjs watch --session your_session_id_here
```

`watch` prints changed one-line diagnostics in the terminal. It does not insert messages into a Codex conversation.

## Privacy

Mallo derives activity metadata in memory from associated local Codex transcripts. It does not persist raw prompts, command arguments, tool results, credentials, or private reasoning. Desktop reporting uses the current task agent's normal context and output tokens; there is no separate reporting model, API key, analytics service, or network reporting service.

## Compatibility

Mallo is alpha software. Windows plugin discovery, native hooks, CLI output, MCP snapshots, and selected-skill summaries have been verified; fixture tests may pass elsewhere, but macOS and Linux have not been verified on real hosts. Other coding-agent hosts are unsupported because their transcripts, hooks, and trust models differ.

## Develop

Run the test suite from the repository root:

```powershell
npm test
```

The tests use temporary session roots and require no model API key. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the current technical contract and validation status.

## License

[MIT](LICENSE)
