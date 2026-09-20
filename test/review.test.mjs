import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { validatePlan, validateReview, validateImplementation, readYaml, writeYamlAtomic } from "../src/contracts.mjs";
import { loadChecks, runChecks, outcomeFromReview, decideRecovery, projectSnapshot } from "../src/runner.mjs";
import { validateRouting, routeTask } from "../src/router.mjs";
import { AppServerClient, defaultServerRequestResponse } from "../src/codex.mjs";
import { ProjectRegistry } from "../src/bindings.mjs";
import { finalizeRun, searchKnowledge, rebuildKnowledge } from "../src/knowledge.mjs";

const criteria = new Set(["boundary", "empty"]);
const plan = () => ({ summary: "Handle inputs", assumptions: [], unresolved_questions: [], work_items: [{ id: "w", dependencies: [], files: ["index.mjs"], behavior: "Validate", criterion_ids: [...criteria], checks: ["node --test"] }] });
const review = () => ({ recommendation: "accept", findings: [], criteria: [...criteria].map((id) => ({ id, verdict: "pass", basis: "execution", evidence_refs: [`check:${id}`] })) });
const checks = [{ id: "boundary", status: "passed" }, { id: "empty", status: "passed" }];
const route = { route: "simple" };

test("completion requires criterion evidence, no major findings, and all work items", () => {
  assert.equal(outcomeFromReview("run-a", route, review(), checks, false).status, "completed");
  const major = review(); major.findings.push({ severity: "major", text: "Missing required behavior", evidence_ref: "stage:implementation" });
  assert.equal(outcomeFromReview("run-a", route, major, checks, false).status, "failed");
  const unrelated = [{ id: "unrelated", status: "passed" }];
  const outcome = outcomeFromReview("run-a", route, review(), unrelated, false);
  assert.equal(outcome.status, "failed");
  assert.ok(outcome.criteria.every((c) => c.verdict === "unknown"));
  assert.equal(outcomeFromReview("run-a", route, review(), checks, false, { blockers: [], work_items: [{ id: "w", status: "skipped" }] }).status, "failed");
  const empty = review(); empty.criteria[0].evidence_refs = [];
  assert.throws(() => validateReview(empty, criteria, new Set(checks.map((c) => `check:${c.id}`))), /requires evidence/);
  const malformed = review(); malformed.recommendation = "whatever";
  assert.throws(() => validateReview(malformed, criteria, new Set()), /Invalid recommendation/);
});

test("schema validation covers required work and bounds instead of relying on server outputSchema", () => {
  const missing = plan(); missing.work_items[0].criterion_ids = ["boundary"];
  assert.throws(() => validatePlan(missing, criteria), /omits criterion: empty/);
  const bad = plan(); bad.work_items[0].files = "index.mjs";
  assert.throws(() => validatePlan(bad, criteria), /array/);
  assert.throws(() => validateImplementation({ summary: "Done", work_items: [], changed_files: [], blockers: [], learning_candidates: [] }, new Set(["w"])), /omits work item/);
  const implementation = { summary: "Done", work_items: [{ id: "w", status: "completed", evidence: "Changed index.mjs" }], changed_files: ["index.mjs"], blockers: [], learning_candidates: [{ applies_when: "A boundary is exact", recommended: "Test it", avoid: "Skip it", scope: "project", tags: ["boundary"], criterion_ids: ["boundary"], relations: [] }] };
  assert.equal(validateImplementation(implementation, new Set(["w"])), implementation);
  const withoutRelations = structuredClone(implementation); delete withoutRelations.learning_candidates[0].relations;
  assert.throws(() => validateImplementation(withoutRelations, new Set(["w"])), /missing relations/);
  const config = { models: { planning: "gpt-6-astra", implementation: "gpt-5.6-sol" }, effort: { triage: "medium", normal: "high", complex: "xhigh" }, limits: { sol_repairs: 2, astra_replans: 1 } };
  assert.equal(validateRouting(config), config);
  assert.deepEqual(routeTask({ task_kind: "review", complexity: "simple", ambiguity: "low", risk: "low" }, "Review the current function", config).stages, ["triage", "check", "review", "record"]);
  assert.throws(() => validateRouting({ ...config, models: { ...config.models, implementation: "other" } }), /requires Astra/);
  assert.throws(() => validateRouting({ ...config, limits: { sol_repairs: 99, astra_replans: 1 } }), /retry limit/);
  assert.equal(decideRecovery({ review: { recommendation: "replan" }, checks, repairAttempt: 2, replanAttempt: 0, limits: config.limits }), "stop");
  assert.equal(decideRecovery({ review: { recommendation: "blocked" }, checks: [{ status: "failed" }], repairAttempt: 0, replanAttempt: 0, limits: config.limits }), "stop");
});

test("check configuration is fixed before workers run and execution uses native sandbox", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-check-policy-")));
  try {
    const path = resolve(root, ".codex-system-checks.json");
    const config = { checks: [{ id: "test", argv: ["node", "--test"], timeout_ms: 1000 }] };
    await writeFile(path, JSON.stringify(config));
    const snapshot = await loadChecks(root);
    const seen = [];
    const client = { executeCommand: async (args) => { seen.push(args); return { exitCode: 0, stdout: "ok", stderr: "" }; }, terminateCommand: async () => {} };
    const control = { cancelled: false, poll: async () => {} };
    assert.equal((await runChecks(root, snapshot, client, control))[0].status, "passed");
    assert.deepEqual(seen[0].sandboxPolicy.writableRoots, [root, seen[0].env.TEMP]);
    assert.equal(seen[0].sandboxPolicy.networkAccess, false);
    assert.equal(seen[0].sandboxPolicy.excludeTmpdirEnvVar, false);
    assert.equal(seen[0].env.TEMP, seen[0].env.TMP);
    assert.match(seen[0].env.TEMP, /\.codex-system[\\/]tmp[\\/]check-/);
    assert.equal(seen[0].env.CODEX_SYSTEM_MANAGED_RUN, null);
    assert.equal(seen[0].env.CODEX_SYSTEM_DATA_ROOT, null);
    config.checks[0].argv = ["node", "-e", "console.log('forged')"];
    await writeFile(path, JSON.stringify(config));
    assert.equal((await runChecks(root, snapshot, client, control))[0].status, "blocked");
    assert.equal(seen.length, 1);
    const outside = resolve(root, "outside"); const project = resolve(root, "project");
    await mkdir(outside); await mkdir(project);
    await symlink(outside, resolve(project, "escape"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(resolve(project, ".codex-system-checks.json"), JSON.stringify({ checks: [{ id: "escape", argv: ["node", "--test"], cwd: "escape" }] }));
    await assert.rejects(loadChecks(project), /escapes project/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("derived node tests do not require npm or pnpm wrappers", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-derived-check-")));
  try {
    await writeFile(resolve(root, "package.json"), JSON.stringify({ scripts: { test: 'node --test "test/*.test.mjs"' } }));
    const snapshot = await loadChecks(root);
    assert.deepEqual(snapshot.checks[0].argv, [process.execPath, "--test", "test/*.test.mjs"]);
    assert.equal(snapshot.source, "derived");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("transport rejects disconnected turns immediately and declines permission grants correctly", async () => {
  const client = new AppServerClient({ codexPath: "unused" });
  client.request = async () => ({ turn: { id: "turn-1" } });
  const pending = client.runTurn({ threadId: "thread-1", input: "test", model: "gpt-5.6-sol", effort: "medium", timeoutMs: 10000, onTurnStarted: () => client.emit("exit", { code: 1 }) });
  await assert.rejects(pending, /disconnected during turn/);
  assert.deepEqual(defaultServerRequestResponse("item/permissions/requestApproval"), { permissions: {}, scope: "turn" });
});

test("transport resumes a known thread without hydrating its full history", async () => {
  const client = new AppServerClient({ codexPath: "unused" });
  let observed;
  client.request = async (method, params) => { observed = { method, params }; return { thread: { id: params.threadId }, model: params.model }; };
  await client.resumeThread({ threadId: "thread-1", model: "gpt-5.6-sol", cwd: "C:/project" });
  assert.equal(observed.method, "thread/resume");
  assert.equal(observed.params.excludeTurns, true);
  assert.equal(observed.params.threadId, "thread-1");
});

test("usage accumulates turn deltas without counting cumulative events twice", async () => {
  const client = new AppServerClient({ codexPath: "unused" });
  client.request = async () => ({ turn: { id: "turn-1" } });
  for (const [total, expected] of [[100, 100], [170, 70]]) {
    const result = await client.runTurn({ threadId: "t", input: "test", model: "gpt-5.6-sol", effort: "medium", onTurnStarted: () => {
      for (let i = 0; i < 2; i++) client.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "t", turnId: "turn-1", tokenUsage: { total: { totalTokens: total } } } });
      client.emit("notification", { method: "turn/completed", params: { threadId: "t", turn: { id: "turn-1", status: "completed", items: [] } } });
    } });
    assert.equal(result.metadata.usageDelta.totalTokens, expected);
  }
});

test("source snapshots detect committed changes even when git diff is empty", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-snapshot-review-")));
  try {
    const git = (args) => assert.equal(spawnSync("git", ["-C", root, ...args], { windowsHide: true }).status, 0);
    git(["init"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(resolve(root, "file.txt"), "original"); git(["add", "file.txt"]); git(["commit", "-m", "base"]);
    const before = await projectSnapshot(root);
    await writeFile(resolve(root, "file.txt"), "changed"); git(["add", "file.txt"]); git(["commit", "-m", "change"]);
    assert.notEqual(await projectSnapshot(root), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed execution creates a provisional scoped lesson and source index exceeds 100 entries", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-brain-review-")));
  try {
    const project = resolve(root, "workspace", "app"); await mkdir(project, { recursive: true });
    const registry = new ProjectRegistry({ hubRoot: root }); const entry = await registry.register(project);
    const runId = "run-44444444-4444-4444-8444-444444444444";
    const runRoot = resolve(project, ".codex-system", "runs", runId);
    await writeYamlAtomic(resolve(root, ".local", "run-index", `${runId}.yaml`), { run_id: runId, run_root: runRoot, project_id: entry.project_id, project_root: project });
    await writeYamlAtomic(resolve(runRoot, "outcome.yaml"), { run_id: runId, status: "failed", planning_only: false, final_artifact_revision: "hash", review_revision: 1, criteria: [{ id: "boundary", verdict: "fail", basis: "execution", evidence_refs: ["check:boundary"] }] });
    await writeYamlAtomic(resolve(runRoot, "checks", "1.yaml"), { checks: [{ id: "boundary", status: "failed" }] });
    await writeYamlAtomic(resolve(runRoot, "learning-candidates.yaml"), { candidates: [{ scope: "project", applies_when: "Exact boundary", recommended: "Inspect boundary test", avoid: "Repeat unchecked change", tags: ["boundary"], criterion_ids: ["boundary"] }] });
    const result = await finalizeRun({ hubRoot: root, runId });
    assert.equal(result.patterns.length, 1);
    const path = resolve(root, "knowledge", "patterns", `${result.patterns[0].id}.yaml`);
    const pattern = await readYaml(path);
    assert.equal(pattern.kind, "failure_prevention"); assert.equal(pattern.status, "provisional");
    assert.equal((await finalizeRun({ hubRoot: root, runId })).patterns[0].duplicate, true);
    for (let i = 0; i < 105; i++) await writeYamlAtomic(resolve(root, "knowledge", "patterns", `pattern-${String(i).padStart(3, "0")}.yaml`), { ...pattern, id: `pattern-${i}`, scope: "shared", recommended: i === 104 ? "unique-search-target" : "Some other action" });
    const rebuilt = await rebuildKnowledge({ dataRoot: root }); assert.equal(rebuilt[0].patterns, 106);
    const query = { schema_version: 1, project_id: entry.project_id, task_summary: "unique-search-target", stage: "plan", environment: "win32" };
    assert.ok((await searchKnowledge({ dataRoot: root, input: query })).cards.some((card) => card.id === "pattern-104"));
    await writeYamlAtomic(resolve(root, "knowledge", "patterns", "pattern-104.yaml"), { ...pattern, id: "pattern-104", scope: "shared", recommended: "unique-search-target", environments: ["linux"] });
    assert.ok((await searchKnowledge({ dataRoot: root, input: query })).cards.every((card) => card.id !== "pattern-104"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
