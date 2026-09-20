import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { ProjectRegistry, isWithin } from "./bindings.mjs";
import { rebuildBrain } from "./brain.mjs";
import { readYaml } from "./contracts.mjs";
import { acquireOwnedLock, releaseOwnedLock } from "./locks.mjs";
import { parse, stringify } from "yaml";

export async function exportBackup({ hubRoot, destination }) {
  const maintenance = await acquireOwnedLock(resolve(hubRoot, ".local", "maintenance.lock"), { operation: "backup-export" }, "Codex System maintenance is already active");
  try { return await exportUnlocked({ hubRoot, destination }); }
  finally { await releaseOwnedLock(maintenance); }
}

async function exportUnlocked({ hubRoot, destination }) {
  await assertQuiescent(hubRoot);
  const root = resolve(destination);
  if (isWithin(resolve(hubRoot, "brain"), root) || isWithin(resolve(hubRoot, ".local"), root)) throw new Error("Backup destination must be outside mutable Codex System data");
  await mkdir(root, { recursive: true });
  try { await readFile(resolve(root, "manifest.json")); throw new Error("Backup destination already contains a manifest"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const registry = await new ProjectRegistry({ hubRoot }).load();
  const items = [];
  const missingEvidence = [];
  await copyYamlTree(resolve(hubRoot, "brain", "patterns"), resolve(root, "brain", "patterns"), items, root);
  for (const project of registry.projects) {
    const rootId = hash(project.root).slice(0, 12);
    await copyYamlTree(resolve(project.root, ".codex-system", "patterns"), resolve(root, "project-patterns", project.project_id, rootId), items, root);
  }
  for (const item of [...items]) {
    const pattern = await readYaml(resolve(root, item.path));
    for (const evidence of pattern.evidence ?? []) {
      const source = evidence.source_run_root;
      if (!source) { missingEvidence.push({ pattern_id: pattern.id, run_id: evidence.run_id, reason: "source path not recorded" }); continue; }
      try {
        await stat(resolve(source, "outcome.yaml"));
        for (const name of ["outcome.yaml", "task.yaml", "checks", "reviews"]) await copyIfPresent(resolve(source, name), resolve(root, "evidence", evidence.project_id, evidence.run_id, name), items, root);
      } catch (error) { missingEvidence.push({ pattern_id: pattern.id, run_id: evidence.run_id, reason: error.message }); }
    }
  }
  await assertQuiescent(hubRoot);
  for (const item of items) if (hash(await readFile(item.source)) !== item.sha256) throw new Error(`Source changed during backup: ${item.path}; retry when writers are idle`);
  const manifest = { schema_version: 1, created_at: new Date().toISOString(), source_hub: resolve(hubRoot), registry_revision: registry.revision, projects: registry.projects.map(({ project_id, root: projectRoot, git_common_dir }) => ({ project_id, original_root: projectRoot, git_common_dir })), items: items.map(({ source, ...item }) => item), missing_evidence: missingEvidence };
  await writeFile(resolve(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return manifest;
}

export async function importBackup({ hubRoot, source, projectRoots = {} }) {
  const maintenance = await acquireOwnedLock(resolve(hubRoot, ".local", "maintenance.lock"), { operation: "backup-import" }, "Codex System maintenance is already active");
  try { return await importUnlocked({ hubRoot, source, projectRoots }); }
  finally { await releaseOwnedLock(maintenance); }
}

async function importUnlocked({ hubRoot, source, projectRoots }) {
  if (!projectRoots || typeof projectRoots !== "object" || Array.isArray(projectRoots)) throw new Error("projectRoots must be a project-id mapping");
  await assertQuiescent(hubRoot);
  const backupRoot = await realpath(resolve(source));
  const manifest = JSON.parse(await readFile(resolve(backupRoot, "manifest.json"), "utf8"));
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.items) || manifest.items.length > 50_000) throw new Error("Unsupported backup manifest");
  const files = new Map();
  for (const item of manifest.items) {
    if (typeof item.path !== "string" || !/^(brain\/patterns|project-patterns|evidence)\//.test(item.path) || item.path.split(/[\\/]/).some((part) => part === ".." || !part) || files.has(item.path)) throw new Error("Invalid or duplicate backup item path");
    const path = resolve(backupRoot, item.path);
    if (!isWithin(backupRoot, await realpath(path))) throw new Error(`Backup item escapes source: ${item.path}`);
    const bytes = await readFile(path);
    if (hash(bytes) !== item.sha256) throw new Error(`Backup hash mismatch: ${item.path}`);
    files.set(item.path, bytes);
  }
  const knownProjects = new Map((manifest.projects ?? []).map((project) => [project.project_id, project]));
  const mappedRoots = new Map();
  for (const [projectId, root] of Object.entries(projectRoots)) {
    if (!knownProjects.has(projectId) || typeof root !== "string") throw new Error(`Invalid restore project mapping: ${projectId}`);
    mappedRoots.set(projectId, await realpath(resolve(root)));
  }
  const currentRegistry = await new ProjectRegistry({ hubRoot }).load();
  for (const [projectId, root] of mappedRoots) {
    const conflict = currentRegistry.projects.find((project) => resolve(project.root).toLowerCase() === resolve(root).toLowerCase() && project.project_id !== projectId);
    if (conflict) throw new Error(`Relocation destination already belongs to ${conflict.project_id}`);
  }
  const destinations = [];
  let relocatedEvidence = 0;
  for (const [path, sourceBytes] of files) {
    const transformed = path.startsWith("brain/patterns/") || path.startsWith("project-patterns/")
      ? relocatePatternEvidence(sourceBytes, files, hubRoot)
      : { bytes: sourceBytes, relocated: 0 };
    const bytes = transformed.bytes;
    relocatedEvidence += transformed.relocated;
    let destinationRoot = resolve(hubRoot);
    let relativePath = path.startsWith("evidence/") ? `.local/restored-evidence/${path.slice(9)}` : path;
    if (path.startsWith("project-patterns/")) {
      const [, projectId, , ...rest] = path.split("/");
      const mappedRoot = mappedRoots.get(projectId);
      if (mappedRoot) { destinationRoot = mappedRoot; relativePath = `.codex-system/patterns/${rest.join("/")}`; }
      else relativePath = `.local/restored-project-patterns/${path.slice(17)}`;
    }
    const destination = resolve(destinationRoot, relativePath);
    if (!isWithin(destinationRoot, destination)) throw new Error("Restore destination escapes its mapped root");
    await assertDestination(destinationRoot, destination);
    let exists = false;
    try {
      if (hash(await readFile(destination)) !== hash(bytes)) throw new Error(`Restore conflict: ${destination}`);
      exists = true;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    destinations.push({ path, destination, bytes, exists });
  }
  // Preflight every hash and conflict before importing any manifest item.
  for (const item of destinations) {
    if (item.exists) continue;
    await mkdir(dirname(item.destination), { recursive: true });
    await writeFile(item.destination, item.bytes, { flag: "wx" });
  }
  const registry = new ProjectRegistry({ hubRoot });
  for (const [projectId, projectRoot] of mappedRoots) await registry.registerRelocated({ projectId, projectPath: projectRoot, originalRoot: knownProjects.get(projectId).original_root, allowMaintenance: true });
  await rebuildBrain({ hubRoot });
  const report = { schema_version: 1, imported_at: new Date().toISOString(), source: backupRoot, shared_patterns: (await safeFiles(resolve(hubRoot, "brain", "patterns"))).length, project_patterns_archived: [...files.keys()].some((path) => path.startsWith("project-patterns/") && !mappedRoots.has(path.split("/")[1])), project_mappings: Object.fromEntries(mappedRoots), relocated_evidence: relocatedEvidence, missing_evidence: manifest.missing_evidence ?? [] };
  await mkdir(resolve(hubRoot, ".local"), { recursive: true });
  await writeFile(resolve(hubRoot, ".local", "restore-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function relocatePatternEvidence(bytes, files, hubRoot) {
  const pattern = parse(bytes.toString("utf8"), { maxAliasCount: 0, uniqueKeys: true });
  let relocated = 0;
  for (const evidence of pattern.evidence ?? []) {
    if (!evidence.project_id || !evidence.run_id || !files.has(`evidence/${evidence.project_id}/${evidence.run_id}/outcome.yaml`)) continue;
    evidence.original_source_run_root ??= evidence.source_run_root ?? null;
    evidence.source_run_root = resolve(hubRoot, ".local", "restored-evidence", evidence.project_id, evidence.run_id);
    relocated += 1;
  }
  return { bytes: Buffer.from(stringify(pattern, { lineWidth: 0 }), "utf8"), relocated };
}

async function copyYamlTree(source, destination, items, backupRoot) {
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    await copyFile(resolve(source, entry.name), resolve(destination, entry.name), items, backupRoot);
  }
}

async function copyIfPresent(source, destination, items, backupRoot) {
  try {
    const metadata = await stat(source);
    if (metadata.isFile()) {
      await copyFile(source, destination, items, backupRoot);
      return;
    }
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      const from = resolve(source, entry.name);
      const to = resolve(destination, entry.name);
      if (entry.isDirectory()) await copyIfPresent(from, to, items, backupRoot);
      else await copyFile(from, to, items, backupRoot);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function copyFile(source, destination, items, backupRoot) {
  const digest = hash(await readFile(source));
  const existing = items.find((item) => resolve(backupRoot, item.path) === destination);
  if (existing) {
    if (existing.sha256 !== digest) throw new Error(`Conflicting backup source: ${source}`);
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { errorOnExist: true, force: false });
  items.push({ path: relative(backupRoot, destination).replaceAll("\\", "/"), sha256: digest, source });
}

async function assertDestination(hubRoot, path) {
  let parent = dirname(path);
  while (true) {
    try {
      const actual = await realpath(parent);
      const root = await realpath(hubRoot).catch(() => resolve(hubRoot));
      if (isWithin(hubRoot, parent) && !isWithin(root, actual)) throw new Error("Restore destination resolves outside hub");
      return;
    } catch (error) { if (error.code !== "ENOENT") throw error; parent = dirname(parent); }
  }
}

async function assertQuiescent(hubRoot) {
  const registry = await new ProjectRegistry({ hubRoot }).load();
  const locks = [resolve(hubRoot, ".local", "projects.lock"), resolve(hubRoot, "brain", ".store.lock"), ...registry.projects.map((p) => resolve(p.root, ".codex-system", ".store.lock"))];
  try { for (const name of await readdir(resolve(hubRoot, ".local", "locks"))) if (name.endsWith(".lock")) locks.push(resolve(hubRoot, ".local", "locks", name)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const path of locks) {
    let owner;
    try { owner = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    let live = false;
    try { process.kill(owner.pid, 0); live = true; } catch (error) { live = error.code !== "ESRCH"; }
    if (live) throw new Error(`Backup requires idle writers: ${path}`);
  }
}

async function safeFiles(path) {
  try { return (await readdir(path)).filter((name) => name.endsWith(".yaml")); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
