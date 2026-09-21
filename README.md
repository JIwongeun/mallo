<div align="center">
  <img src="plugins/mallo/assets/mallo.png" width="110" alt="Mallo mascot">
  <h1>Mallo</h1>
  <p><strong>See models, effort, and skill reads.</strong></p>
  <p>
    <a href="https://github.com/JIwongeun/mallo/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/JIwongeun/mallo/actions/workflows/ci.yml/badge.svg"></a>
    <img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-F59E0B">
    <img alt="Node.js 24+" src="https://img.shields.io/badge/Node.js-24%2B-417E38">
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2563EB">
  </p>
  <p><a href="#what-you-see">Examples</a> · <a href="#install">Install</a> · <a href="#use">Use</a> · <a href="CONTRIBUTING.md">Contribute</a></p>
</div>

Mallo makes model and task activity easier to read in Codex. See the recorded model, reasoning effort, task, and skill reads behind the work, from the main conversation to delegated subtasks.

- **Show activity:** inspect the work observed so far in the current Codex turn.
- **Task summary:** review the main and subagent activity after the work finishes.

Mallo reads existing local Codex history. It needs no separate model or API key; checkpoints use the current task's normal tokens.

The first release supports **Codex Desktop and CLI**.

## What you see

During work, **Show activity** gathers the current native turn's observed main and subagent tasks in one checkpoint. Open the latest checkpoint to see activity so far. Once work finishes, **Task summary** provides the final snapshot. Both retain every visible skill name, one per line.

The examples below show Mallo's output text with illustrative tasks. Codex controls the surrounding tool labels, grouping, colors, and expansion.

### Codex Desktop

**During implementation:** one checkpoint contains the main task and observed subtasks.

<details open>
<summary>Show activity</summary>

```text
GPT-6-Astra/xhigh (main) Plan authentication changes
- brainstorming

GPT-5.6-Sol/high (sub) Implement sign-in flow
- test-driven-development
- caveman

GPT-5.5/medium (sub) Run regression tests
```

</details>

**After the work:** one summary, with a separate block for each observed task turn.

<details open>
<summary>Task summary</summary>

```text
GPT-6-Astra/xhigh (main) Plan authentication changes
- brainstorming

GPT-5.6-Sol/high (sub) Implement sign-in flow
- test-driven-development
- caveman
- verification-before-completion
- ponytail

GPT-5.5/medium (sub) Run regression tests
```

</details>

Each block starts with `model/effort (main|sub) task`, followed by one `- skill` line per observed skill. With no observed reads, only the task line appears. Full task and skill lists have no `+N` or preview cutoff. Numeric GPT model names use `GPT-` consistently, with `Astra`, `Sol`, `Terra`, and `Luna` capitalized; versions and other suffixes stay intact. Other model IDs and raw JSON metadata stay unchanged. Missing effort appears as `unknown`. Skill names indicate observed reads, not proof of application; Mallo's own observer skill is excluded.

Mallo keeps calls separate from unrelated tools and places the final summary immediately before the answer. It cannot force a standalone item or merge old calls. Each new progress result contains the latest cumulative view.

### Codex CLI

**MCP checkpoints:** CLI uses the same `Show activity` and `Task summary` tools. A progress result contains plain text like this; the final summary uses the same layout with the activity observed by completion.

```text
GPT-6-Astra/xhigh (main) Plan authentication changes
- brainstorming

GPT-5.6-Sol/high (sub) Implement sign-in flow
- test-driven-development
- caveman

GPT-5.5/medium (sub) Run regression tests
```

**Shell fallback:** when MCP is unavailable, the current-view CLI prints the same task blocks without Markdown escapes. For example, from the source checkout inside a Codex Bash task shell:

```bash
node plugins/mallo/cli.mjs status --session "${CODEX_THREAD_ID:-$CODEX_SESSION_ID}" --view current --phase progress --format plain
```

Example output uses native task labels; MCP calls can supply the descriptive aliases shown above:

```text
GPT-6-Astra/xhigh (main) Main task
- brainstorming

GPT-5.6-Sol/high (sub) implement sign in flow
- test-driven-development
- caveman

GPT-5.5/medium (sub) run regression tests
```

Default output and `--format plain` are identical. Use `--phase summary` for the final snapshot. `--format markdown` is for Markdown consumers. Codex may show the command as a `Ran ...` item and collapse long output; Mallo cannot hide or restyle that wrapper.

**Optional hook notifications:** trusted CLI hooks add compact, one-line status messages. These use bracketed skill previews; the MCP and shell views above contain the full lists.

```text
Mallo · In progress · GPT-5.6-Sol/high (sub) implement sign in flow [test-driven-development, caveman]
Mallo · Native turn completed · GPT-5.6-Sol/high (sub) implement sign in flow [test-driven-development, caveman] · Turn tools 4/4
```

Codex displays hook messages with warning styling. The example marks a native turn boundary, not a verified project outcome.

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

1. Open a new Codex task or CLI session to load the plugin.
2. Select `$mallo` to request checkpoints during work and one final summary.
3. Open the latest **Show activity** result for activity so far, or **Task summary** after completion.

For example, ask: `Use $mallo while reviewing this repository for bugs.`

Codex can also select Mallo for relevant multi-step work. Automatic selection is best effort; selecting `$mallo` explicitly requests it for that task.

For additional compact CLI hook messages, review and trust the Mallo hooks with `/hooks`. Hook trust is separate from the MCP checkpoints above.

## Update

From the source checkout:

```powershell
git pull --ff-only
codex plugin add mallo@mallo
```

Open a new Codex task after updating.

## Privacy and support

Mallo keeps derived activity metadata in memory. It does not store raw prompts, command arguments, tool results, credentials, or private reasoning. It needs no model API key or network reporting service.

Native discovery, installed MCP startup, and plain CLI output have been verified on Windows and Linux. Interactive hook delivery has been verified on Windows; Linux interactive rendering and macOS still need verification. Report bugs through [GitHub Issues](https://github.com/JIwongeun/mallo/issues) without posting raw transcripts or credentials. See [SECURITY.md](SECURITY.md) for private vulnerability reports.

## Develop

Run `npm test` from the repository root. Tests use temporary session roots and need no model API key. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the technical contract.

MIT licensed. See [LICENSE](LICENSE).
