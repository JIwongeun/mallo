import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { exportBackup, importBackup } from "../src/backup.mjs";
import { writeYamlAtomic } from "../src/contracts.mjs";

test("backup restores independent Knowledge and rejects conflicting user data", async () => {
  const base = await mkdtemp(join(tmpdir(), "relay-backup-"));
  try {
    const source = resolve(base, "source");
    const archive = resolve(base, "archive");
    const restored = resolve(base, "restored");
    await mkdir(source, { recursive: true });
    const observation = {
      id: "observation-1", basis: "execution", outcome: "pass", criterion: "Boundary passes", criterion_ids: ["boundary"],
      check: "boundary", check_ids: ["boundary"], result: "boundary: passed", environment: "test", artifact_digest: "abc", observed_at: "2026-09-20T00:00:00.000Z", origin: { project_id: "project-1", run_id: "run-1" },
    };
    for (const id of ["boundary", "portable"]) await writeYamlAtomic(resolve(source, "knowledge", "patterns", `${id}.yaml`), {
      schema_version: 2, id, revision: 1, scope: "shared", kind: "success_pattern", stages: ["verify"], tags: [id], status: "provisional",
      applies_when: `${id} applies`, recommended: `Use ${id}`, avoid: `Skip ${id}`, observations: [{ ...observation, id: `observation-${id}` }], relations: [], assessments: [],
    });
    await writeYamlAtomic(resolve(source, "settings.yaml"), { schema_version: 1, routing: { limits: { sol_repairs: 1 } } });
    const manifest = await exportBackup({ hubRoot: source, destination: archive });
    assert.equal(manifest.schema_version, 2);
    assert.equal(manifest.items.length, 3);
    await writeFile(resolve(archive, "knowledge", "patterns", "unlisted.yaml"), "not: imported\n");
    const report = await importBackup({ hubRoot: restored, source: archive });
    assert.equal(report.imported, 3);
    assert.deepEqual(await readdir(resolve(restored, "knowledge", "patterns")), ["boundary.yaml", "portable.yaml"]);
    assert.match(await readFile(resolve(restored, "knowledge", "patterns", "portable.yaml"), "utf8"), /artifact_digest: abc/);
    assert.ok(await readFile(resolve(restored, "knowledge", "index.sqlite")));
    const userData = "user: modified\n";
    await writeFile(resolve(restored, "knowledge", "patterns", "boundary.yaml"), userData);
    await assert.rejects(importBackup({ hubRoot: restored, source: archive }), /Restore conflict/);
    assert.equal(await readFile(resolve(restored, "knowledge", "patterns", "boundary.yaml"), "utf8"), userData);
  } finally { await rm(base, { recursive: true, force: true }); }
});
