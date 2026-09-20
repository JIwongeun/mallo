import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ProjectRegistry } from "../src/bindings.mjs";
import { applyFeedback, mergeCandidate, rebuildKnowledge, searchKnowledge } from "../src/knowledge.mjs";
import { readYaml, writeYamlAtomic } from "../src/contracts.mjs";

test("Knowledge deduplicates evidence, isolates projects, and survives origin deletion", async () => {
  const hub = await realpath(await mkdtemp(join(tmpdir(), "codex-system-brain-")));
  try {
    const first = resolve(hub, "workspace", "first");
    const second = resolve(hub, "workspace", "second");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const registry = new ProjectRegistry({ hubRoot: hub });
    await registry.register(first);
    await registry.register(second);
    const binding = await registry.resolve(first);
    const runId = "run-11111111-1111-4111-8111-111111111111";
    const runRoot = resolve(first, ".codex-system", "runs", runId);
    await writeYamlAtomic(resolve(hub, "state", "run-index", `${runId}.yaml`), { run_id: runId, run_root: runRoot, project_id: binding.projectId, project_root: first });
    await writeYamlAtomic(resolve(runRoot, "outcome.yaml"), { schema_version: 1, status: "completed", planning_only: false, criteria: [{ id: "boundary", verdict: "pass", basis: "execution", evidence_refs: ["check:boundary"] }, { id: "other", verdict: "pass", basis: "execution", evidence_refs: ["check:boundary"] }] });
    await writeYamlAtomic(resolve(runRoot, "checks", "1.yaml"), { schema_version: 1, checks: [{ id: "boundary", status: "passed" }] });
    const evidence = { project_id: binding.projectId, run_id: runId, stage: "verify", artifact_revision: "1", review_revision: 1, outcome: "pass", basis: "execution", check_ids: ["boundary"], criterion_ids: ["boundary"], source_run_root: runRoot };
    const local = { applies_when: "한국어 만료 경계를 검사할 때", recommended: "경계 시각을 포함해 검사한다", avoid: "경계 직전만 검사한다", tags: ["만료", "boundary"] };
    const created = await mergeCandidate({ hubRoot: hub, binding, candidate: local, evidence });
    const duplicate = await mergeCandidate({ hubRoot: hub, binding, candidate: local, evidence });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.revision, created.revision);
    await assert.rejects(mergeCandidate({ hubRoot: hub, binding, candidate: local, evidence, expectedRevision: 99 }), /revision conflict/);

    const shared = await mergeCandidate({ hubRoot: hub, binding, candidate: { scope: "shared", applies_when: "A time boundary controls validity", recommended: "Test the exact boundary", avoid: "Test only neighboring values", tags: ["boundary", "expiry"] }, evidence });
    const counterexample = await mergeCandidate({ hubRoot: hub, binding, candidate: { scope: "shared", applies_when: "A strict cutoff intentionally excludes the exact sentinel", recommended: "Keep the strict comparison and test the excluded sentinel", avoid: "Changing an exclusive rule to inclusive", tags: ["exclusive", "sentinel"] }, evidence });
    const related = await mergeCandidate({ hubRoot: hub, binding, candidate: { scope: "shared", applies_when: "A time boundary controls validity", recommended: "Test the exact boundary", avoid: "Test only neighboring values", tags: ["boundary", "expiry"], relations: [{ type: "contradicts", target_id: counterexample.id }] }, evidence });
    assert.equal(related.revision, shared.revision + 1);
    const sharedRecord = await readYaml(resolve(hub, "knowledge", "patterns", `${shared.id}.yaml`));
    assert.equal(sharedRecord.schema_version, 2);
    assert.equal(sharedRecord.observations[0].origin.run_id, runId);
    assert.equal(sharedRecord.relations[0].target_revision, counterexample.revision);
    assert.equal(sharedRecord.relations[0].evidence_refs[0].run_id, runId);
    await rebuildKnowledge({ dataRoot: hub });
    const localResult = await searchKnowledge({ dataRoot: hub, input: query(binding.projectId, "만료 경계", ["만료"]) });
    assert.ok(localResult.cards.some((card) => card.id === created.id));
    const secondBinding = await registry.resolve(second);
    const isolated = await searchKnowledge({ dataRoot: hub, input: query(secondBinding.projectId, "expiry boundary", ["expiry"]) });
    assert.ok(isolated.cards.some((card) => card.scope === "shared"));
    assert.ok(isolated.cards.every((card) => card.id !== created.id));
    assert.ok(isolated.cards.some((card) => card.id === counterexample.id && card.retrieval_reason === "one-hop contradicts"));
    const unrelated = await searchKnowledge({ dataRoot: hub, input: query(secondBinding.projectId, "Plan a React dashboard accessibility and rendering performance improvement", ["React", "accessibility", "rendering", "performance"]) });
    assert.deepEqual(unrelated.cards, []);

    const lockPath = resolve(hub, "knowledge", ".store.lock");
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, nonce: "competing-writer" }));
    await assert.rejects(mergeCandidate({ hubRoot: hub, binding, candidate: { scope: "shared", applies_when: "A separate concurrent update", recommended: "Serialize the write", avoid: "Overwriting canonical state", tags: ["concurrency"] }, evidence }), /store is busy/);
    await unlink(lockPath);

    const interrupted = resolve(hub, "knowledge", "patterns", "interrupted.yaml");
    await writeFile(interrupted, "schema_version: 1\nid: interrupted\n");
    await assert.rejects(rebuildKnowledge({ dataRoot: hub }), /Invalid knowledge record/);
    await unlink(interrupted);

    await assert.rejects(applyFeedback({ hubRoot: hub, runId, feedback: { schema_version: 1, verdict: "rejected", text: "Unknown criterion.", criterion_ids: ["missing"] } }), /unknown criterion/);
    const rejected = await applyFeedback({ hubRoot: hub, runId, feedback: { schema_version: 1, verdict: "rejected", text: "The lesson needs revalidation.", criterion_ids: ["boundary"] } });
    assert.ok(rejected.affected_patterns.every((pattern) => pattern.status === "needs_revalidation"));
    const corrected = await applyFeedback({ hubRoot: hub, runId, feedback: { schema_version: 1, verdict: "accepted", text: "The correction is confirmed by the original execution evidence." } });
    assert.ok(corrected.affected_patterns.every((pattern) => pattern.status === "provisional"));

    await rm(first, { recursive: true, force: true });
    await rebuildKnowledge({ dataRoot: hub });
    const deleted = await searchKnowledge({ dataRoot: hub, input: query(binding.projectId, "만료 경계", ["만료"]) });
    assert.ok(deleted.cards.some((card) => card.id === created.id && card.evidence_level === "provisional"));
  } finally {
    await rm(hub, { recursive: true, force: true });
  }
});

function query(projectId, task, originalTerms) {
  return { schema_version: 1, project_id: projectId, task_summary: task, stage: "plan", environment: "test", original_terms: originalTerms, english_terms: [], exact_errors: [], referenced_pattern_ids: [] };
}
