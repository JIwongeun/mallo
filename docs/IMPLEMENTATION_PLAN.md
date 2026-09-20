# Sol implementation handoff — independent Relay plugin

Status: **implementation and local release verification in progress**, revised 2026-09-20. R0-R8 replace the earlier hub/workspace plan. The completed M0-M7 release remains a historical baseline; its checks do not close these new gates. Current evidence is summarized in section 8 and the ignored `.local/implementation-evidence/release-vnext.json` record.

## 1. Required outcome and agreed scope

The user opens any local project folder in Codex, including this framework's source repository, and requests work normally. The installed plugin identifies that folder, selects installed skills and Astra/Sol stages, reports meaningful progress, executes checks, and captures reusable lessons in an independent personal Knowledge store. The development repository need not be attached, present at its original path, or accessible to ordinary project workers.

An installed release remains unchanged while Sol edits the next version's source. Only a verified Git revision becomes an installable release. Promotion updates this plugin, preserves personal data and retains a known-good rollback artifact. An already-open conversation does not automatically acquire new native tools/hooks.

Decisions:

- Remove the permanent `workspace/` requirement. Its 12 known acceptance projects are synthetic framework fixtures. Delete those verified fixtures and their trial knowledge; do not preserve whole test projects solely to keep old evidence paths alive. Future tests use disposable temporary directories and isolated data roots.
- Rename Brain to **Knowledge**. Store lessons with enough retained evidence to understand, assess and reuse them without the original project. Original paths are optional provenance, not dependencies.
- Use **Relay** as the default public display name and `relay` as the entry skill name. Keep internal plugin ID `codex-system`, MCP tool namespace and `.codex-system/` project record directory stable for this release. New canonical knowledge uses `knowledge/`.
- Keep one SessionStart hook unless a reproduced native limitation requires another. The hook introduces the entry skill; one controller owns the workflow. Do not create one hook or skill per stage.
- Show progress in the existing chat. No separate dashboard service, browser server, desktop app or scheduled notification system.
- The user manages external skills/hooks. Discover, validate and select them; never install, update, modify, disable or remove them. This framework's own plugin installation/update is in scope.
- Use only Astra/Sol. Sol medium triage, Astra high planning/review, Sol high implementation; xhigh for complex/ambiguous/high-risk stages. Keep at most two Sol repairs and one Astra replan per run.
- Exclude Jev, embeddings, extra API proxies, multi-user services, comparative benchmarks and Obsidian integration.
- Use English for agent instructions, schemas, settings and machine records; Korean is allowed for human guides. Preserve exact requests, identifiers and error evidence.

Keep this as the single detailed handoff, plus essential AGENTS and a short README. No additional planning documents or transcript copies in Git. Implement the smallest changes that meet the gates; do not add speculative infrastructure.

## 2. Verified starting point

| Area | Observed implementation | Required change |
| --- | --- | --- |
| Git | `main` has initial commit `7f0bdb8`; implementation files are mostly untracked; README modified | Review and checkpoint actual source before refactoring |
| Versions | package.json `0.1.0`; installed plugin `0.1.1+codex.20260920071315`; MCP reports `0.1.1` | One base version and exact release provenance |
| MCP launch | `.mcp.json` reads the user pointer, launches `hub_root/plugins/codex-system/server.mjs`, then `hub_root/src/cli.mjs` | Both entries must execute from a fixed installed release |
| Paths | CLI equates `sourceRoot` with mutable data home; modules use `hubRoot` | Separate runtime root, user data root and selected project scope |
| Binding | Registry rejects unregistered folders; registration rejects this repository | Automatic first-use identity, including self-development |
| Brain | Canonical records use external run paths for evidence resolution | Retain compact evidence within independent Knowledge |
| Fixtures | 12 synthetic workspace directories, including a linked worktree; observed shared patterns cite synthetic runs | Provenance-based cleanup; do not infer ownership from names alone |
| Progress | Transitions reach MCP but summaries are sparse and some events are only in memory | Durable cursors and factual user-readable events |
| Appearance | Codex System display, entry skill `codex-system`, no icon | Relay metadata, entry skill and validated assets |

The previous source passed 41 tests and bounded real desktop/model/MCP/reuse/fresh-source checks. Historical evidence: `.local/implementation-evidence/release-current.json` and `final-source.json`. The previous plan is retained only in ignored `implementation-plan-v1-historical.md` under that evidence directory. Preserve baseline observations honestly; deleted synthetic sources may later be unavailable. Do not treat old evidence as proof of refactored behavior.

## 3. Runtime/data/project contract

Use a small shared resolver where paths repeat, not a storage/provider framework:

```js
{ runtimeRoot, dataRoot, projectRoot, cwd, allowedRoots, releaseId }
```

- `runtimeRoot`: verified immutable executable package, shipped defaults and production dependencies. Never resolve executable source from the editable checkout.
- `dataRoot`: `${CODEX_HOME || <user-home>/.codex}/codex-system`; permit an explicit override for isolated tests. No authentication copies or unrelated config edits.
- `projectRoot`: selected primary working folder. Preserve actual invocation `cwd`; inspect Git root/common directory for identity and worktree locks without widening authorized writes.
- `allowedRoots`: actual session/project filesystem scope. Neither registry history nor gitignore grants access. Do not select a secondary/sibling project by guessing its name.
- `releaseId`: verified package/version/content identity captured at admission and persisted in the run. Never reread “latest” between stages to choose a different controller.

Target ownership:

```text
development repository/    source, tests, defaults, plugin metadata, essential docs
installed release/        complete executable package; unchanged during use
<dataRoot>/
  knowledge/              canonical lessons and rebuildable search index
  state/                  identities, run locators, locks, progress cursors
  settings.yaml           sparse personal overrides
  releases/               owned verified artifacts/receipts for rollback
  installation.json       active/candidate/previous identity and health state
selected project/
  .codex-system/          requests, plans, checks, outcomes, project-local context
  normal source files    user code and intentional deliverables
```

Create only directories actually needed. Keep personal data, packages, dependencies, caches and execution records out of source Git. Never recreate `workspace/` during install, doctor, hooks or execution. Uninstall preserves personal Knowledge/settings and project records.

The registry becomes an identity/history index, not an enrollment allowlist. Preserve known relocation/worktree IDs, canonical Windows path handling, nested-repository detection and one writer lock per Git common directory. Hooks stay read-only: no registering every visited folder, sibling scans, `.gitignore` changes or project-state creation until a task is admitted.

## 4. Independent Knowledge

Evolve `src/brain.mjs` into `src/knowledge.mjs`; update callers and CLI verbs. Reuse YAML validation, atomic writes, scoped relations and FTS5. A narrow legacy reader/command alias may support migration, but there must be only one active canonical store.

Knowledge holds reusable lessons; project records retain detailed execution history. A lesson may be shared or project-scoped. Both remain usable after origin deletion, but retrieval exposes only shared lessons and the current project's eligible entries. Do not silently promote private context to shared knowledge.

Minimum v2 record, illustrative only; do not seed it into the user's store:

```yaml
schema_version: 2
id: knowledge-example
revision: 1
scope: shared
kind: failure_prevention
status: provisional
title: Check exact boundary behavior
applies_when: The upper bound is inclusive.
recommended: Execute checks at the exact limit and adjacent values.
avoid: Treating equality as an over-limit value.
exceptions: Exclusive bounds require different behavior.
tags: [boundary, validation]
observations:
  - id: observation-example
    basis: execution
    outcome: pass
    criterion: The exact inclusive maximum remains unchanged.
    check: A focused boundary test executed successfully.
    result: Exact-limit, below-limit and above-limit cases passed.
    environment: <relevant observed environment>
    artifact_digest: <observed digest>
    observed_at: <observed timestamp>
    origin: {project_id: <opaque ID>, run_id: <opaque ID>}
relations: []
assessments: []
```

An observation must retain actual compact support, not just a hash or model approval. Include criterion/check identity, outcome, relevant environment and a sanitized short excerpt if necessary. Do not copy secrets, whole conversations or project source trees. Optional source paths can aid diagnosis but cannot be required for retrieval.

Admission and use:

1. Validate outcomes, criteria, executed checks and artifact/review revisions while source evidence exists. Models propose lessons; controller evidence determines admission. No useful lesson is a valid result.
2. Atomically store the generalized lesson and necessary evidence snapshot. Deduplicate by stable observation identity. Relations require scoped evidence; similarity never proves equivalence, contradiction or a universal ban.
3. Search validates canonical records and current applicability. Remove dependence on `access(originalRunPath)` for admitted evidence quality. Losing optional provenance does not downgrade/hide a complete lesson.
4. Distinguish review evidence, execution, user feedback, environment blocks and changed requirements. Preserve conservative provisional/validated transitions; model confidence alone cannot promote knowledge.
5. Preserve evidence-backed failed-attempt lessons even when a repair later succeeds. Link the failed condition and correction; do not blame unrelated stages or label an environment prerequisite as a code failure.
6. Append assessment revisions for corrections. Counterexamples or environment changes can invalidate applicability; origin-folder deletion alone cannot.
7. Retain FTS5, original and Sol-normalized terms, compatibility filtering, bounded relations and at most three cards. Rebuild from Knowledge alone. No embeddings.
8. Skill associations are advisory. Recheck current inventory, dependencies, source hashes and worker tools. Selection, attachment, observed use and criterion-supported outcomes remain distinct.

Migration validates genuine old records and captures their missing support while available. Incomplete records become `needs_revalidation` with a specific reason. Delete entries proven to originate exclusively from framework fixtures; preserve mixed/unknown provenance for inspection. Backup/restore must work without any original project directory. Do not restore all synthetic trial knowledge merely because it existed in the old Brain.

## 5. Self-development and Git release lifecycle

Steady-state flow:

```text
ordinary request in framework source repo
  -> installed A admits and pins one run
  -> Astra plans; Sol edits source for B; actual checks/review finish
  -> reviewed local Git commit; verified candidate built from that commit
  -> run completes under A
  -> native plugin update and health/trust/discovery checks
  -> eligible new sessions use B; compatible A remains recoverable
```

The source repo is an ordinary target. Its edits must not change the controller, server, defaults or dependencies executing the current run. Never implement an update by pointing at the working tree. Preserve the worker recursion marker and one-controller rule.

### Source, version and package rules

- Make local commits for meaningful verified slices, using a `codex/` branch. Stage explicit source/doc/test paths and inspect staged content. Preserve unrelated changes; no blind `git add .`, reset, force-push or history rewriting.
- Local commit/tag and local plugin update are authorized during implementation. Remote push, public releases and marketplace publication are not authorized by this handoff.
- Use one base semver for package/plugin/server. Target `0.2.0` unless an existing verified release already occupies it. Do not invent a historical `v0.1.1` tag for the inconsistent current versions.
- Native cachebuster metadata refreshes discovery; it is not semantic version advancement. Follow the installed plugin-creator helper/update/validation workflow. Commit any helper-generated source-manifest change before building the candidate.
- Build from an explicit committed tree and locked production dependencies. Generate an artifact manifest outside that source commit containing source SHA, base/native version, schema compatibility, runtime requirements and sorted relative file hashes. Avoid a self-referential commit digest.
- Keep active and previous verified artifacts. Never replace different bytes under one release identity, move existing version tags, or prune a running version.
- Verify supported installed-root resolution on this host; do not assume a hook variable also expands in MCP config. Server, controller and YAML dependency must come from the package or an owned immutable release copy, not the checkout.

### Promotion and recovery

Use a small durable journal: `built -> verified -> installing -> awaiting_native_action | active | failed`. Record previous identity before installation. Native installation is not assumed atomic; implement compensating recovery without adding a daemon.

Promotion requires a verified artifact and no active managed runs/writers. A self-development worker cannot promote the runtime controlling it; the outer release action runs after terminal state and process cleanup. Preserve native configuration ownership, actual marketplace identity and hook trust. Never auto-grant trust or copy credentials into an alternate home.

Mark active only after package hashes, startup, allowed models, required skill/MCP discovery and applicable hook trust pass. If native trust/reload needs user action, finish independent preparation, retain the exact pending state and report the required action. Keep disk-installed version separate from the version loaded by an already-open conversation. Existing tasks keep their loaded version until a supported reload/new session.

Rollback reinstalls/selects the previous owned package and verifies health. It must not overwrite newer Knowledge observations with an older snapshot. Declare supported data-schema ranges; prefer backward-readable/additive updates. An incompatible previous runtime must refuse startup honestly. Before incompatible data migration, create/validate a recovery snapshot and define what rollback can preserve; never imply arbitrary schema downgrades are safe.

## 6. Entry, progress and branding

The SessionStart hook announces availability for the selected workspace regardless of registration, skips managed workers, and performs no inference or writes. Controller admission enforces scope/permissions. Availability is not forced interception of every message.

The entry skill starts one run, reports new progress, asks only actual pending questions, forwards exact answers and reports the true terminal result. Information questions skip managed work. Status/cancel acts on the current run. Keep existing MCP tool IDs compatible unless a demonstrated protocol need requires migration.

Extend existing state/events rather than build another workflow engine. Bounded events contain `run_id`, monotonic `sequence`, `state_revision`, `release_id`, `stage`, `status`, actual model/effort when known and a short factual summary. Persist replayable cursors; progress survives controller/MCP restart and callers receive only unseen events.

Report admission, route/skill selection, stage transitions, check results, needed input, failure/cancel and Knowledge outcome. Coalesce repeats and avoid narrating every tool call. During long work, briefly report the actual stage if necessary. No invented percentage, ETA, savings or dollar invoice. Retain input/output/cached usage and turn deltas.

Example, using only observed values:

```text
Relay · current project
Request classified — Sol · medium
Plan under review — Astra · high
Implementation started — Sol · high
Checks complete — 8 passed, 0 failed
Knowledge — 1 provisional lesson recorded
```

Use chat commentary/native tool presentation first; custom native widgets are not assumed available. Update display names, descriptions, starter prompts, hook messages and entry skill consistently. Generate an original small-readable two-path connection icon via the image-generation skill/tool, including light/dark assets where needed. Validate real `composerIcon`, `logo`, `logoDark` and `brandColor` fields with installed plugin tooling. No placeholder screenshots or edits to external assets. Stable internal identity prevents duplicate installed plugins/hooks when renaming.

## 7. Existing guarantees that must survive

- Separate routing, state, transport, selection and Knowledge. One writer per repository/worktree family; only owners release locks. Refresh retained worker context after relevant skill/config/hook changes.
- Simple route: Sol triage -> bounded retrieval -> Sol implementation -> sandboxed checks -> separate Sol assessment -> record. Planned route: triage -> retrieval -> Astra plan/plan review -> Sol implementation -> checks -> Astra review -> record. Planning/review-only requests never grant implementation permission.
- Establish criteria before mutation. Validate structured results, dependency order, file scope and final snapshots. Process exit zero/model completion/reviewer acceptance are not interchangeable with task success.
- Freeze applicable checks before implementation; preserve native sandbox and approval boundaries. Never execute shell-concatenated model command strings. Missing prerequisites stop dependent work; repair/replan counters survive resume.
- Cancel/disconnect stops owned workers. Resume does not replay unknown side effects or stale approval. Preserve original request and primary scope.
- Discover current user-managed skills, including explicit-only policy, qualified identities, conflicts, pins, dependencies and worker tools. Negative constraints must not become positive matches. No hardcoded third-party roster.
- Keep versioned task/state/stage/check/review/outcome/feedback records and source attestations. Add release/schema/event identities without erasing historical assessments.

## 8. Ordered implementation slices

Use existing modules before adding files. Proposed commands below are targets, not existing features. Keep one ignored vNext state/evidence record separate from completed M0-M7. Verify each gate before progressing to dependent work; continue independent work when a native action is pending.

### Current implementation record

| Gate | State | Evidence |
| --- | --- | --- |
| R0 | passed | Baseline commit `c0e9438`; frozen runtime `legacy-0.1.1-c0e9438`; executable hash `04d35198d347e758d1e438967de3b6e38de50b5636d7ffdae92af04b5ee6ad0c`; owned pointer backup and startup check recorded locally. |
| R1 | passed | Runtime/data/project paths are separate. Release tests package a clean commit, verify every file, move the source checkout out of reach, and start the packaged CLI. Installed releases also completed an external-project run without importing the source checkout. |
| R2 | passed | Registry tests cover unregistered plain folders, Git repositories and linked worktrees; SessionStart inspection is read-only; admission uses Git local exclude instead of editing project `.gitignore`. |
| R3 | passed | Canonical schema-2 Knowledge embeds observations and survives origin deletion and backup/restore. Legacy migration skipped the two provenance-confirmed fixture-only lessons and admitted no personal fixture data. |
| R4 | code verified | Relay metadata, original transparent icon, entry skill and durable progress events validate. Promotion and native package discovery were recorded, but installed UI trust was not observed. |
| R5 | passed | All 12 provenance-confirmed fixtures, linked worktree, trial run state and legacy `brain/` were removed. Two obsolete validation tasks were archived to release Windows handles. `workspace/` is absent. |
| R6 | passed with native evidence | Unit acceptance covers immutable build, tamper rejection, previous release preservation, active-run blocking and Knowledge-preserving rollback. The first live acceptance, `run-73b959e8-ea53-4484-9ab3-71c839a074ff` on `0.2.0-198444d103d0`, was blocked because the sandbox could not spawn `npm test` (`CreateProcessAsUserW failed: 2`, Windows error 2). Commit `e38cfde` (`fix: run Node checks without npm wrapper`) replaced the wrapper, and `run-609e1003-e754-4cec-a350-eab236f2b282` on `0.2.0-e38cfde908ee` completed with exit code 0 and 2/2 fixture tests passing. The real promote/rollback/re-promote sequence completed; the installation receipt now records `0.2.0-bc114394e530` active and retains `0.2.0-e38cfde908ee` as previous. This does not establish installed UI trust. |
| R7 | in progress | Installed run `run-e05948fb-7593-4614-947d-616c2efb5111` on `0.2.0-e38cfde908ee` used Astra planning, Sol implementation and Astra review to add compact release output, but its controller check was blocked because the Windows sandbox denied global temp writes. After the first temp fix, installed run `run-f7fffb08-79ee-4e52-9010-1ca5be9b3c2f` on `0.2.0-bc114394e530` updated this evidence but correctly remained blocked: 39 tests passed and 5 exposed that a project-local temp changed Git identity while Relay-only environment variables leaked into checks. The controller now uses the independent data-root temp as an explicit writable root and removes those Relay variables; 44/44 normal tests and an actual sandboxed `command/exec` full-suite check pass. R7 remains in progress until a fixed installed run is terminal and its candidate is promoted. |
| R8 | pending | Final acceptance follows real promotion, rollback, native discovery and R7 proof. |

### R0 — Checkpoint and freeze the legacy runtime

1. Inspect instructions, Git status, source/install receipts, owned pointer and active writers. Verify actual runtime/models without exposing credentials. Capture the old source manifest and known synthetic roots.
2. Review untracked files and make an explicit local baseline commit of required source/tests/docs/metadata/lockfile, excluding personal data, workspace and dependencies. Create a `codex/` branch while preserving user changes.
3. Before executable edits, freeze the old runtime and locked dependencies in an owned per-user legacy location. The old architecture combines code/data; a one-time bootstrap can use frozen code alongside mutable legacy subdirectories there. Under a quiescent writer check, copy only required registry/run locators and canonical data. Never blindly copy `.local` or authentication directories.
4. Point only the framework's owned launch configuration/receipt at that verified legacy runtime, including server and CLI. Keep a recoverable prior pointer. Only the selected legacy data copy is active; repository data becomes migration input, not a second writable store.
5. This initial upgrade runs normally in the Sol implementation task: v0.1 cannot yet self-manage this repo. Do not claim self-hosting prematurely. Remove bootstrap-only branches after independent runtime validation while preserving an honest legacy rollback boundary.

Gate R0: [ ] reviewed baseline commit exists; editing candidate source does not change installed execution bytes; legacy startup/data binding and owned pointer recovery pass.

### R1 — Separate paths and package the complete runtime

1. Replace source-directory-as-data-home assumptions in `cli`, `install`, `bindings`, `runner`, `control`, `locks`, `backup` and Knowledge. Reuse one minimal runtime/data/project resolver.
2. Load immutable defaults plus validated sparse user overrides; record effective policy revision per run. Keep Node built-ins and the locked YAML dependency.
3. Package server/controller/source/defaults/skill/hook/assets and production dependency closure. Native install must not require a live development checkout or its `node_modules`.
4. Verify installed-root resolution for MCP and hooks, custom CODEX_HOME, Unicode/spaces, and desktop startup without developer PATH. Any runtime locator must identify the immutable release, never editable source.
5. Separate receipts from personal data; preserve uninstall ownership checks. Ignore generated packages and local artifacts.

Gate R1: [ ] a bounded installed task works with source checkout unavailable; no imports/defaults reference it; installed files remain unchanged; Windows/custom-home launch checks pass.

### R2 — Automatically bind the selected folder

1. Refactor registry admission: remove enrollment prerequisite, hub rejection and `workspace_child`; preserve identity, canonical paths, worktrees, relocation conflicts and writer locks.
2. Verify allowed roots before creating records. Support external Git, non-Git, selected subfolder and nested-repository cases without widening writes or merging unrelated identities.
3. Update hook/skill/MCP/doctor behavior. Hooks stay read-only; framework source follows the same entry path; admitted tasks do not get duplicate implementation in the outer chat.
4. Preserve existing check configuration. For new projects, inspect real manifests/test tooling and derive or propose justified argv, frozen before mutation. Do not require every user to hand-author `.codex-system-checks.json`, invent passing checks, or run arbitrary model-provided shell strings. An unresolved essential check blocks implementation honestly; planning may proceed.
5. Keep necessary `.gitignore`/local-setup edits minimal and scoped. Ask for target selection only when the native session provides no unambiguous primary folder.

Gate R2: [ ] external Git/plain/worktree/source-repo tasks bind without registration; ambiguous/secondary/junction cases preserve scope; information-only visits create no records.

### R3 — Implement independent Knowledge

1. Evolve `brain.mjs` into `knowledge.mjs` and update contracts/callers/CLI/tests. Source validation happens at admission; later source-path resolution is optional.
2. Persist compact evidence snapshots, condition-specific failures and corrections; preserve deduplication, revisions, scoped relations and concurrent-write safety.
3. Migrate genuine legacy data with honest missing-support status. Keep one canonical writable store; exclude known fixture-only lessons from operational data.
4. Make search/rebuild/feedback/relations/backup operate on canonical Knowledge alone. Recheck applicability and present at most three cards.
5. In an isolated data root, execute a task, capture a real lesson, remove the disposable source project, rebuild and reuse the lesson in another project. Keep observations separate from fixtures injected for failure-branch tests.

Gate R3: [ ] origin deletion does not downgrade complete evidence or break later reuse; restored Knowledge needs no project folders; failed/review-only/duplicate/revised observations remain correct; no acceptance lessons pollute personal data.

### R4 — Improve progress and Relay presentation

1. Extend controller events and existing records with bounded summaries and durable cursors. Status cannot depend solely on MCP memory.
2. Update entry-skill reporting for admission, stage changes, input, long-running work, cancellation and terminal results; preserve exact request/response semantics.
3. Apply Relay display and `relay` entry skill; update recursion exclusions/framework source IDs. Keep MCP IDs/data paths stable and verify implicit/explicit invocation after native reload.
4. Generate icon assets using image/plugin skills, preview small/light/dark versions, validate manifest paths and verify native discovery. No unsupported custom UI or duplicate installed plugin.

Gate R4: [ ] actual chat shows factual model/stage/check/Knowledge progress; reconnect/busy/cancel behavior is clear; metadata/icons validate and are observed in the installed UI.

### R5 — Delete synthetic workspace data and obsolete paths

1. Stop relevant writers, identify exact synthetic roots and migrated trial patterns/registry/run-index entries by provenance, and inspect for unexpected user additions. Do not classify by names alone.
2. Remove the known linked test worktree through Git while its owner exists; delete only verified synthetic targets. On Windows, resolve/check every recursive target under the intended legacy workspace root; do not follow junctions into unrelated data. A concrete unknown-data conflict requires clarification, not guessing.
3. Delete trial-only Knowledge and rebuild indexes. Preserve unrelated/mixed evidence. Whole acceptance projects need not be archived; compact historical summaries can note unavailable old sources.
4. Remove the empty workspace directory, creation assumptions, `workspace_child`, permanent fixture machinery and obsolete source-pointer branches. Tests default to temp folders and isolated Knowledge. Retain legacy ignore coverage until deleted paths cannot accidentally enter Git.
5. Rename current Brain references to Knowledge; label narrow compatibility code. Remove duplication without removing checks, scope isolation, locks or recovery.

Gate R5: [ ] workspace is absent and never recreated; known trial knowledge is gone; tests leave personal state unchanged; no stale runtime dependency or unexplained deletion remains.

### R6 — Implement verified releases and rollback

1. Add minimal installer/CLI operations and a build helper where needed: proposed `release build --ref`, `release inspect`, `release promote`, `release rollback`. Validate explicit refs, paths and hashes; document commands only once implemented.
2. Synchronize versions, run native cachebuster tooling when needed, commit manifest changes and build from the exact Git tree. Validate artifact contents and locked dependencies; a version-string edit is not a release gate.
3. Implement quiescent promotion, previous-artifact retention, schema compatibility and native verification. Promotion runs outside workers. Use the actual configured marketplace and preserve unrelated settings.
4. Exercise dirty-source rejection, tampering, failed build, interrupted installation, trust pending, loaded-session mismatch, failure and rollback. Preserve newer Knowledge/settings.
5. Record source commit, base/native version, package digest, installed path, previous version, data schema and health. Local immutable tags identify verified source. No remote push/public release.

Gate R6: [ ] A remains unchanged while B is edited; unverified B cannot activate; fresh native discovery uses promoted B; compatible rollback preserves data; active runs block updates and release identity is visible.

### R7 — Prove self-development through the installed skill

1. With an immutable release installed, open this source repo as primary and make a bounded ordinary maintenance request. Use an existing user-opened task if its plugin snapshot is suitable; otherwise finish preparation and state the exact reload/new-task action needed. Do not create app tasks without explicit authorization.
2. Observe one correctly bound managed run: installed runtime path/digest, Astra plan/review, Sol source change, actual checks and terminal result. Use a useful maintenance correction identified during implementation, not an empty edit made solely to claim success.
3. Verify executing release hashes remain identical before/after source edits. Locally commit the verified change, build its candidate, wait for the old run to finish, and promote outside that managed run.
4. Verify the next eligible session reports the new release. Reuse R6 artifacts/checks; do not manufacture redundant releases or claim an existing chat hot-reloaded.

Gate R7: [ ] installed-skill self-development actually uses Astra/Sol, preserves the running release and then activates the verified candidate in native discovery; direct outer-chat edits/mocked workers do not count.

### R8 — Final acceptance and handoff

1. Run the appropriate full regression suite after stabilization; repeat affected tests after actual fixes. Inspect Git content for secrets, fixture data and personal Knowledge.
2. Complete the matrix below with compact real evidence and labeled fixtures. Reuse earlier observations only when their relevant hashes/assumptions match.
3. Update README to real install/use/update/rollback commands and limits. Record final commit, installed package, data root and pending native actions. Check gates only from observed results.
4. Complete a new implementation Goal only after required gates pass. The earlier completed Goal remains historical; this document does not create or reopen one. Required trust/discovery still pending means acceptance is incomplete.

Gate R8: [ ] R0-R7 evidence supports the final revision; installation, scope, Knowledge independence, cleanup, progress, appearance, self-development, update and rollback work with consistent Git/runtime/data identities.

## 9. Acceptance matrix

| Scenario | Required evidence |
| --- | --- |
| Source-independent execution | Real packaged run with checkout unavailable; executable paths/hashes |
| Automatic binding and scope | External Git/plain/worktree/source-repo entry; secondary/parent/junction boundary fixtures |
| Independent Knowledge | Two related actual tasks using an isolated store, with origin deletion before retrieval/reuse |
| Evidence semantics | Failure-then-repair, review-only, environment block, duplicate and feedback fixtures |
| Cleanup | Provenance manifest; no permanent workspace or fixture knowledge in personal store |
| Progress/icons | Real visible transitions/terminal state; validated assets and installed UI observation |
| External skills | Existing selection/dependency/context tests plus isolated native lifecycle checks |
| Git release | Exact source commit/tag, versions, lockfile and artifact manifest/hashes |
| Run version pinning | Controller/promotion fixtures plus actual self-development |
| Update/rollback | Real local install/discovery and compatible recovery without personal-data loss |
| Fresh setup | No ignored development state or copied credentials; supported existing auth |

Use Windows-safe argv and bounded outputs. Never mutate actual external extensions for tests. Read installed native protocol/plugin specifications before assuming lifecycle behavior. If a core native promise cannot be met, report the exact gap instead of substituting a mocked acceptance trace.

## 10. Sol start/resume instructions

Read this document and AGENTS; inspect state and begin at the first open R gate. The first upgrade may run as a normal Sol xhigh implementation task; the delivered runtime retains the Astra/Sol stage policy. Editing config cannot switch the current conversation's model.

Keep one ignored vNext checkpoint with gate, source/package revision, evidence, installed release, active data root and next concrete action. Verify it on resume. Ask only for truly missing information or native actions unsupported by tools; finish independent work first. Implementation authorization covers local code, framework install, bounded acceptance, known synthetic cleanup and local Git history, not external skill changes or remote publication.

Copy-ready request after the user selects Sol:

> `docs/IMPLEMENTATION_PLAN.md`의 R0–R8 구현을 새 Goal로 설정하고 진행해줘. 설치본과 개발 소스를 분리하고, 폴더 사전 등록 없는 사용, 독립적인 Knowledge, 검증용 workspace 정리, Relay 이름·아이콘·진행 보고, Git 기반 버전업·업데이트·롤백, 설치된 스킬을 통한 자체 코드 수정까지 구현·설치·실제 검증해줘. 외부 스킬은 변경하지 말고 원격 push·공개 배포는 하지 마. 모든 필수 게이트를 실제로 확인한 뒤 Goal을 완료 처리해줘.
