# Mallo portability plan

Status: design reviewed on 2026-09-21; additional hosts are not implemented.
Initial recommendation: Codex and Claude Code. OpenCode and custom runtimes follow only when selected and verified.

## Product contract

Mallo shows current task activity and one final activity summary. It observes execution; it does not route models, execute tasks, add inference calls, or keep a second activity database. Display text and task aliases remain English. Preserve the current compact row format and omit empty skill brackets.

Integrate with the agent host that manages sessions, tools, skills, and workers. Model providers are a separate dimension. A host adapter can cover different backends when the host exposes their metadata. A raw inference API cannot supply a host's skill and worker activity unless the calling application reports it.

## Smallest reusable boundary

The existing `getStatus()` result in `plugins/codex-system/lib/activity.mjs` is the starting snapshot contract. Keep its provenance and coverage information; do not introduce a parallel event store.

- **Host reader:** read authorized native transcripts or documented events; resolve native session, task, parent, model, effort, skill evidence, and completion boundaries.
- **Shared presentation:** select associated tasks, preserve separate worker turns, deduplicate unchanged observations, and format progress and summary rows.
- **Host delivery:** return the native hook response or MCP result the host supports. Reading an event does not guarantee that the host will display it.

`currentActivity()` already accepts a `statusReader`, but it is not portable unchanged: UUID validation, Codex hook names, and turn-window association still assume Codex. Keep ID and hook validation at host boundaries. Namespace internal identity by host and session; never correlate different hosts by a coincident ID or timestamp alone.

Extract only presentation functions needed by a real second adapter. Avoid an adapter registry, generic plugin loader, new web service, or empty future-host directories. Keep the current Codex install self-contained and its `codex-system@personal` identifier compatible. Decide shared-source packaging with the second install target; each installed artifact must contain its runtime files and work without the development checkout.

## Evidence rules

- Preserve host-reported and configured/requested model or effort as distinct evidence. Never turn a requested route into execution confirmation.
- Preserve unsupported or unavailable fields as missing; do not invent effort levels or map different providers' effort scales by name.
- Distinguish skill-file reads, explicit skill invocation, and preloaded configuration. Keep exact skill identifiers; missing events do not prove no skill was used.
- Prefer English task labels supplied by the current agent or host. Use neutral labels when unavailable; add no translation model.
- Only read canonical allowed transcript roots and explicitly associated tasks. Never publish or persist raw prompts, arguments, results, credentials, or reasoning.
- Keep missing or partial coverage visible. Host failures must not change or block the user's task.

## Host delivery assessment

| Host | Available integration | Verification still required |
| --- | --- | --- |
| Codex | Existing transcript reader, MCP checkpoints, trusted CLI hooks | Preserve current fixtures and native integration checks after extraction |
| Claude Code | Documented hook inputs, transcript paths, user-facing synchronous `systemMessage`; status lines are optional | Minimum version, current model source, turn/worker linkage, skill evidence, actual CLI/Desktop delivery |
| OpenCode | Documented plugin event stream; separate CLI plugin surface | Installed major version, event schema, native display support, permissions |
| Custom API/local-model application | Application-provided activity metadata | Explicit input contract and a display surface owned by that application |

Claude Code hook inputs vary by event and version. Model is not present on every hook; effort may be absent. Transcript writes may lag. Its asynchronous hook output is not interchangeable with a synchronous user-facing message. Do not copy the Codex hook configuration or use context injection as a display workaround. Do not replace an existing user status line.

## Implementation sequence

1. Preserve the reviewed Codex source and existing installation as the regression baseline.
2. Choose the second host and supported version; capture sanitized native evidence for one main task and one subtask, including a task with no skills.
3. Extract the existing formatter/scoping boundary with no Codex behavior change. Keep host-specific validation and association in the host adapter.
4. Implement the second reader against real evidence, producing the minimal shared snapshot. Test missing effort, non-UUID IDs, partial records, and skill provenance.
5. Add the host's native progress and completion delivery without controlling execution or changing unrelated user configuration.
6. Package and install each adapter independently. Test from a clean checkout or temporary install so no development-root imports are hidden.
7. Verify discovery, input evidence, hook/tool delivery, and visible rendering separately. Check failures, duplicate events, concurrent subtasks, and response completion.
8. Only then update README and plugin descriptions to list the verified hosts. Keep unsupported hosts marked as planned. Commit, push, tag, and publish only when requested.

## Official references

- [Claude Code hooks](https://code.claude.com/docs/en/hooks): input fields, event-specific output, transcript timing, and trust.
- [Claude Code status lines](https://code.claude.com/docs/en/statusline): model/effort metadata and subagent rows; configured effort is not always applied effort.
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference): host packaging.
- [OpenCode plugins](https://opencode.ai/v2/docs/build/plugins) and [CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli): event acquisition and display are distinct integrations.
