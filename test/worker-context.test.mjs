import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { structuredStage } from "../src/runner.mjs";
import { readYaml } from "../src/contracts.mjs";

test("runner replaces retained context after skill resource, inventory, and hook changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-worker-context-"));
  try {
    const skillRoot = join(root, "skill"); await mkdir(skillRoot);
    const path = join(skillRoot, "SKILL.md"); await writeFile(path, "Instructions\n");
    await writeFile(join(skillRoot, "helper.mjs"), "export const value = 1;\n");
    const configPath = join(root, "skills.yaml");
    await writeFile(configPath, "schema_version: 2\npreferences:\n  - id: debugging\n    stages: [implementation, repair]\n");
    let present = true; let hookHash = "original"; let count = 0; const turns = [];
    const client = {
      listSkills: async () => [{ skills: present ? [{ name: "debugging", path, enabled: true }] : [] }],
      listHooks: async () => [{ hooks: [{ key: "fixture", enabled: true, currentHash: hookHash, trustStatus: "trusted" }] }],
      startThread: async ({ model }) => ({ thread: { id: `worker-${++count}` }, model }),
      runTurn: async (args) => { turns.push(args); return { threadId: args.threadId, turnId: `turn-${turns.length}`, turn: { status: "completed" }, finalText: '{"summary":"fixture"}', metadata: { reroutes: [] } }; },
    };
    const threads = new Map(); const runRoot = join(root, "run");
    const args = { client, runRoot, model: "gpt-5.6-sol", effort: "high", cwd: root, prompt: "Repair the fixture", skillsConfigPath: configPath, control: { poll: async () => {} }, threads, hubRoot: root, runId: "fixture", selectedPatterns: [{ id: "p", revision: 1 }] };
    await structuredStage({ ...args, stage: "implementation" });
    await structuredStage({ ...args, stage: "repair-1" });
    assert.equal(turns[0].threadId, turns[1].threadId);
    await writeFile(join(skillRoot, "helper.mjs"), "export const value = 2;\n");
    await structuredStage({ ...args, stage: "repair-2" });
    assert.notEqual(turns[1].threadId, turns[2].threadId);
    assert.ok(!turns[2].input.includes("Retrieved references unchanged"));
    present = false;
    await structuredStage({ ...args, stage: "repair-3" });
    assert.notEqual(turns[2].threadId, turns[3].threadId);
    assert.equal(turns[3].skills.length, 0);
    hookHash = "updated";
    await structuredStage({ ...args, stage: "repair-4" });
    assert.notEqual(turns[3].threadId, turns[4].threadId);
    const input = await readYaml(join(runRoot, "stages", "repair-4", "input.yaml"));
    assert.equal(input.worker_context_invalidated, true);
    assert.equal(input.hooks[0].currentHash, "updated");
    const output = await readYaml(join(runRoot, "stages", "implementation", "output.yaml"));
    assert.equal(output.skill_invocations[0].status, "attached");
    assert.deepEqual(output.skill_invocations[0].observed_use_refs, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
