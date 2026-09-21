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

Mallo is a small activity companion for AI coding agents. See the model, reasoning effort, task, and skill reads behind the work, from the main conversation to delegated subtasks. Local and read-only, with no extra model calls.

The first release supports **Codex Desktop and CLI**.

## What you see

During work, **Show activity** displays only the task being reported. Once work finishes, **Task summary** gathers the observed main and subagent tasks. These illustrative examples follow Mallo's actual output format; the model assignments and task names are examples.

**Main conversation:** planning a change.

<details open>
<summary>Show activity</summary>

```text
GPT-6-Astra/xhigh (main) Plan authentication changes [brainstorming]
```

</details>

**Subagent:** implementing the feature. This checkpoint contains just that subtask.

<details open>
<summary>Show activity</summary>

```text
GPT-5.6-Sol/high (sub) Implement sign-in flow [caveman]
```

</details>

**Another subagent:** running checks, with no observed skill reads. There are no empty brackets or "no skills" labels.

<details open>
<summary>Show activity</summary>

```text
gpt-5.5/medium (sub) Run regression tests
```

</details>

**After the work:** one summary, with one row per observed task.

<details open>
<summary>Task summary</summary>

```text
GPT-6-Astra/xhigh (main) Plan authentication changes [brainstorming]
GPT-5.6-Sol/high (sub) Implement sign-in flow [caveman]
gpt-5.5/medium (sub) Run regression tests
```

</details>

Each row follows `model/effort (main|sub) task [skills]`. Model IDs other than the Astra and Sol display aliases are shown as recorded; missing effort appears as `unknown`. Mallo observes your agent's model choices—it does not choose or switch models. Skill names indicate observed reads, not proof of application.

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

Native integration has been verified on Windows; macOS and Linux still need host verification. Report bugs through [GitHub Issues](https://github.com/JIwongeun/mallo/issues) without posting raw transcripts or credentials. See [SECURITY.md](SECURITY.md) for private vulnerability reports.

## Develop

Run `npm test` from the repository root. Tests use temporary session roots and need no model API key. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the technical contract.

MIT licensed. See [LICENSE](LICENSE).
