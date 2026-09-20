import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { exportBackup, importBackup } from "../src/backup.mjs";
import { readYaml, writeYamlAtomic } from "../src/contracts.mjs";
import { ProjectRegistry } from "../src/bindings.mjs";

test("backup restores canonical shared patterns and rebuilds the derived index", async () => {
  const base = await mkdtemp(join(tmpdir(), "codex-system-backup-"));
  try {
    const source = resolve(base, "source");
    const archive = resolve(base, "archive");
    const restored = resolve(base, "restored");
    const project = resolve(base, "project");
    const relocatedProject = resolve(base, "relocated-project");
    await mkdir(project, { recursive: true });
    await mkdir(relocatedProject, { recursive: true });
    const registered = await new ProjectRegistry({ hubRoot: source }).register(project);
    await writeYamlAtomic(resolve(source, "brain", "patterns", "boundary.yaml"), {
      schema_version: 1, id: "boundary", revision: 1, scope: "shared", kind: "success_pattern",
      stages: ["verify"], tags: ["boundary"], status: "validated", applies_when: "A boundary matters",
      recommended: "Test it", avoid: "Skip it", evidence: [{ run_id: "missing", source_run_root: resolve(base, "missing") }], relations: [],
    });
    const runRoot = resolve(project, ".codex-system", "runs", "run-portable");
    await writeYamlAtomic(resolve(runRoot, "outcome.yaml"), { schema_version: 1, status: "completed", planning_only: false });
    await writeYamlAtomic(resolve(source, "brain", "patterns", "portable.yaml"), {
      schema_version: 1, id: "portable", revision: 1, scope: "shared", kind: "success_pattern",
      stages: ["verify"], tags: ["portable"], status: "provisional", applies_when: "Included evidence is restored",
      recommended: "Use the restored evidence", avoid: "Keep an absolute source path", evidence: [{ project_id: registered.project_id, run_id: "run-portable", source_run_root: runRoot }], relations: [],
    });
    await writeYamlAtomic(resolve(project, ".codex-system", "patterns", "project-portable.yaml"), {
      schema_version: 1, id: "project-portable", revision: 1, scope: "project", project_id: registered.project_id, kind: "success_pattern",
      stages: ["verify"], tags: ["portable"], status: "provisional", applies_when: "A relocated project needs its own lesson",
      recommended: "Preserve the project identity", avoid: "Generate a new identity", evidence: [{ project_id: registered.project_id, run_id: "run-portable", source_run_root: runRoot }], relations: [],
    });
    const manifest = await exportBackup({ hubRoot: source, destination: archive });
    assert.ok(manifest.items.length >= 3);
    assert.equal(manifest.missing_evidence.length, 1);
    await writeFile(resolve(archive, "brain", "patterns", "unlisted.yaml"), "not: a valid pattern\n");
    const report = await importBackup({ hubRoot: restored, source: archive, projectRoots: { [registered.project_id]: relocatedProject } });
    assert.equal(report.shared_patterns, 2);
    assert.equal(report.relocated_evidence, 2);
    assert.equal(report.project_patterns_archived, false);
    assert.equal((await new ProjectRegistry({ hubRoot: restored }).resolve(relocatedProject)).projectId, registered.project_id);
    assert.match(await readFile(resolve(relocatedProject, ".codex-system", "patterns", "project-portable.yaml"), "utf8"), /id: project-portable/);
    const portable = await readYaml(resolve(restored, "brain", "patterns", "portable.yaml"));
    assert.equal(portable.evidence[0].source_run_root, resolve(restored, ".local", "restored-evidence", registered.project_id, "run-portable"));
    assert.ok(await readFile(resolve(portable.evidence[0].source_run_root, "outcome.yaml")));
    assert.match(await readFile(resolve(restored, "brain", "patterns", "boundary.yaml"), "utf8"), /id: boundary/);
    assert.ok(await readFile(resolve(restored, "brain", "index.sqlite")));
    assert.deepEqual(await readdir(resolve(restored, "brain", "patterns")), ["boundary.yaml", "portable.yaml"]);
    const userData = "user: modified\n";
    await writeFile(resolve(restored, "brain", "patterns", "boundary.yaml"), userData);
    await assert.rejects(importBackup({ hubRoot: restored, source: archive }), /Restore conflict/);
    assert.equal(await readFile(resolve(restored, "brain", "patterns", "boundary.yaml"), "utf8"), userData);
  } finally { await rm(base, { recursive: true, force: true }); }
});
