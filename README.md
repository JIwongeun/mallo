<div align="center">
  <img src="plugins/mallo/assets/mallo.png" width="110" alt="Mallo mascot">
  <h1>Mallo</h1>
  <p><strong>See models, effort, and skill reads.</strong></p>
  <p>
    <a href="https://github.com/JIwongeun/mallo/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/JIwongeun/mallo/actions/workflows/ci.yml/badge.svg"></a>
    <img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-F59E0B">
    <img alt="Codex plugin" src="https://img.shields.io/badge/Codex-plugin-111827">
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2563EB">
  </p>
  <p><a href="#install">Install</a> · <a href="#use">Use</a> · <a href="CONTRIBUTING.md">Contribute</a> · <a href="SECURITY.md">Security</a></p>
</div>

Mallo shows coding-agent activity: which model and reasoning effort each task uses, and which skill files were read. It shows focused progress updates and one task summary in native activity logs. Local and read-only, with no extra model calls.

## What you see

The selected `$mallo` skill shows the current task in **Show activity**, then gathers the observed tasks in **Task summary** when the work is done:

```text
GPT-5.6-Sol/high (main) Improve checkpoint display [caveman]
GPT-6-Astra/xhigh (sub) Review integration
```

Bracketed names are observed skill reads, not proof that a skill was applied. Mallo shows recorded model and effort values; a requested route alone is not execution evidence. The Codex CLI also shows trusted hook updates during interactive work.

## Install

You need Node.js 24 or newer, Codex Desktop or CLI with plugin support, and the `codex` command on `PATH`. Clone access is required while this repository is private.

```powershell
git clone https://github.com/JIwongeun/mallo.git
cd mallo
codex plugin marketplace add .
codex plugin add mallo@mallo
```

If the old plugin is installed, run `codex plugin remove codex-system@personal` before adding `mallo@mallo` to avoid two copies.

## Use

1. Open a new Codex task to load the plugin.
2. Review and trust the Mallo hooks with `/hooks`.
3. Select `$mallo` for explicit Desktop checkpoints and the final native summary.

For example, ask: `Use $mallo while reviewing this repository for bugs.`

## Update

From the source checkout:

```powershell
git pull --ff-only
codex plugin add mallo@mallo
```

Open a new Codex task after updating.

## Privacy and support

Mallo keeps derived activity metadata in memory. It does not store raw prompts, command arguments, tool results, credentials, or private reasoning. It needs no model API key or network reporting service.

Mallo supports Codex Desktop and CLI. Native integration has been verified on Windows; macOS and Linux still need host verification. Report bugs through [GitHub Issues](https://github.com/JIwongeun/mallo/issues) without posting raw transcripts or credentials. See [SECURITY.md](SECURITY.md) for private vulnerability reports.

## Develop

Run `npm test` from the repository root. Tests use temporary session roots and need no model API key. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the technical contract.

MIT licensed. See [LICENSE](LICENSE).
