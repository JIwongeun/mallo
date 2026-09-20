import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ProjectRegistry, isWithin } from "../src/bindings.mjs";
import { validatePlan, validateReview, validateTriage, writeYamlAtomic, readYaml } from "../src/contracts.mjs";
import { routeTask } from "../src/router.mjs";
import { assertProtectedRecords, decideRecovery, nextWorkflowState, planNeedsInput, projectSnapshot, snapshotProtectedRecords, validatePlanScope } from "../src/runner.mjs";
import { acquireOwnedLock, releaseOwnedLock } from "../src/locks.mjs";

test("path containment rejects siblings and traversal", () => {
  assert.equal(isWithin("C:/work/app", "C:/work/app/src"), true);
  assert.equal(isWithin("C:/work/app", "C:/work/app-other"), false);
});

test("registry admits the selected folder without prior registration and inspect stays read-only", async () => {
  const hub = await realpath(await mkdtemp(join(tmpdir(), "codex-system-바인딩-")));
  try {
    const child = join(hub, "workspace", "child project");
    const sibling = join(hub, "workspace", "other");
    await mkdir(child, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const registry = new ProjectRegistry({ hubRoot: hub });
    const registered = await registry.register(child);
    const binding = await registry.resolve(child);
    assert.equal(binding.projectId, registered.project_id);
    const inspected = await registry.inspect(sibling);
    assert.equal(inspected.known, false);
    const siblingBinding = await registry.resolve(sibling);
    assert.equal(siblingBinding.projectRoot, sibling);
    assert.notEqual(siblingBinding.projectId, binding.projectId);
    await assert.rejects(access(join(child, ".gitignore")), { code: "ENOENT" });
  } finally {
    await rm(hub, { recursive: true, force: true });
  }
});

test("git worktrees share project identity and retain their own cwd", async () => {
  const hub = await realpath(await mkdtemp(join(tmpdir(), "codex-system-worktree-")));
  try {
    const source = join(hub, "workspace", "source");
    const worktree = join(hub, "workspace", "worktree");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "file.txt"), "source\n");
    for (const args of [["init"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"], ["add", "file.txt"], ["commit", "-m", "initial"]]) {
      const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    }
    const added = spawnSync("git", ["-C", source, "worktree", "add", "-b", "worktree-test", worktree], { encoding: "utf8", windowsHide: true });
    assert.equal(added.status, 0, added.stderr);
    const registry = new ProjectRegistry({ hubRoot: hub });
    const first = await registry.register(source);
    const second = await registry.register(worktree);
    const binding = await registry.resolve(worktree);
    assert.equal(second.project_id, first.project_id);
    assert.equal(binding.projectId, first.project_id);
    assert.equal(binding.projectRoot, worktree);
    assert.equal(binding.cwd, worktree);
    const exclude = spawnSync("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { encoding: "utf8", windowsHide: true });
    assert.equal(exclude.status, 0, exclude.stderr);
    assert.match(await readFile(exclude.stdout.trim(), "utf8"), /\/\.codex-system\//);
  } finally { await rm(hub, { recursive: true, force: true }); }
});

test("atomic YAML records round trip", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-system-record-")));
  try {
    const path = join(root, "nested", "record.yaml");
    await writeYamlAtomic(path, { schema_version: 1, value: "ok" });
    assert.deepEqual(await readYaml(path), { schema_version: 1, value: "ok" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan validation rejects dependency cycles", () => {
  const plan = { summary: "Cycle", assumptions: [], unresolved_questions: [], work_items: [
    { id: "a", dependencies: ["b"], criterion_ids: ["c"], files: [], behavior: "a", checks: [] },
    { id: "b", dependencies: ["a"], criterion_ids: ["c"], files: [], behavior: "b", checks: [] },
  ] };
  assert.throws(() => validatePlan(plan, new Set(["c"])), /cycle/);
});

test("invalid model output cannot pass stage validation", () => {
  assert.throws(() => validateTriage({ task_kind: "fix", complexity: "tiny", risk: "low", ambiguity: "low", affected_surfaces: [], acceptance_criteria: [{ id: "c", text: "works" }], constraints: [], evidence_refs: [], search_terms: [] }), /Invalid complexity/);
  assert.throws(() => validateReview({ recommendation: "accept", findings: [], criteria: [{ id: "c", verdict: "pass", basis: "execution", evidence_refs: ["check:invented"] }] }, new Set(["c"]), new Set()), /unavailable evidence/);
});

test("router forces authentication work through planned path", () => {
  const config = { models: { planning: "gpt-6-astra", implementation: "gpt-5.6-sol" }, effort: { triage: "medium", normal: "high", complex: "xhigh" }, limits: { sol_repairs: 2, astra_replans: 1 } };
  const facts = { task_kind: "implementation", complexity: "simple", risk: "low", ambiguity: "low" };
  assert.equal(routeTask(facts, "Fix login token expiry", config).route, "planned");
  assert.equal(routeTask(facts, "Rename the visible label", config).route, "simple");
});

test("recovery distinguishes repair, replan, and exhausted caps", () => {
  const limits = { sol_repairs: 2, astra_replans: 1 };
  const failed = [{ status: "failed" }];
  assert.equal(decideRecovery({ review: null, checks: failed, repairAttempt: 0, replanAttempt: 0, limits }), "repair");
  assert.equal(decideRecovery({ review: { recommendation: "replan" }, checks: failed, repairAttempt: 0, replanAttempt: 0, limits }), "replan");
  assert.equal(decideRecovery({ review: { recommendation: "repair" }, checks: failed, repairAttempt: 2, replanAttempt: 1, limits }), "stop");
  assert.equal(decideRecovery({ review: null, checks: [], repairAttempt: 0, replanAttempt: 0, limits }), "stop");
});

test("planning-only output can retain implementation questions", () => {
  assert.equal(planNeedsInput({ planningOnly: true }, { unresolved_questions: ["Choose a backend before implementation"] }), false);
  assert.equal(planNeedsInput({ planningOnly: false }, { unresolved_questions: ["Choose a backend before implementation"] }), true);
});

test("workflow state preserves run counters, mutation history, and completed stages", () => {
  const initial = { schema_version: 1, run_id: "run-a", revision: 3, workflow_state: "running", stage: "implementation", started_at: "start", completed_stages: ["triage", "plan"], repair_attempt: 1, replan_attempt: 1, mutations_started: true };
  const next = nextWorkflowState(initial, { revision: 4, workflow_state: "running", stage: "checking", repair_attempt: 2 });
  assert.equal(next.replan_attempt, 1);
  assert.equal(next.mutations_started, true);
  assert.deepEqual(next.completed_stages, ["triage", "plan", "implementation"]);
  const failed = nextWorkflowState(initial, { revision: 4, workflow_state: "failed", stage: "failed" });
  assert.deepEqual(failed.completed_stages, ["triage", "plan"]);
});

test("planned changes stay inside declared files", () => {
  const plan = { work_items: [{ files: ["src/index.mjs", "test/"] }] };
  assert.doesNotThrow(() => validatePlanScope(plan, ["src/index.mjs", "test/index.test.mjs"]));
  assert.throws(() => validatePlanScope(plan, ["package.json"]), /exceeded planned file scope/);
  assert.throws(() => validatePlanScope({ work_items: [{ files: [] }] }, ["src/index.mjs"]), /without declaring/);
  assert.doesNotThrow(() => validatePlanScope({ work_items: [{ files: [] }] }, ["src/index.mjs"], "simple"));
});

test("project snapshots detect changes without counting run records", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-system-snapshot-")));
  try {
    await writeYamlAtomic(join(root, "file.yaml"), { value: 1 });
    const before = await projectSnapshot(root);
    await writeYamlAtomic(join(root, ".codex-system", "state.yaml"), { value: 2 });
    assert.equal(await projectSnapshot(root), before);
    await writeYamlAtomic(join(root, "file.yaml"), { value: 3 });
    assert.notEqual(await projectSnapshot(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker-visible run records cannot change without detection", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-protected-records-")));
  try {
    await writeYamlAtomic(join(root, "task.yaml"), { value: 1 });
    await writeYamlAtomic(join(root, "state.yaml"), { revision: 1 });
    const snapshot = await snapshotProtectedRecords(root);
    await writeYamlAtomic(join(root, "state.yaml"), { revision: 2 });
    await assertProtectedRecords(root, snapshot);
    await writeYamlAtomic(join(root, "task.yaml"), { value: 2 });
    await assert.rejects(assertProtectedRecords(root, snapshot), /untrusted worker or check/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale lock recovery replaces only the observed dead owner", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-lock-recovery-")));
  try {
    const path = join(root, "writer.lock");
    await writeFile(path, JSON.stringify({ pid: 2147483647, nonce: "dead-owner" }));
    const lock = await acquireOwnedLock(path, { run_id: "run-new" });
    const owner = JSON.parse(await readFile(path, "utf8"));
    assert.equal(owner.nonce, lock.nonce);
    assert.equal(owner.recovered_from, "dead-owner");
    await releaseOwnedLock(lock);
    const live = await acquireOwnedLock(path, { run_id: "run-live" });
    await assert.rejects(acquireOwnedLock(path, { run_id: "run-other" }), /busy/i);
    await releaseOwnedLock(live);
  } finally { await rm(root, { recursive: true, force: true }); }
});
