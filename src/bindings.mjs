import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { acquireOwnedLock, assertMaintenanceInactive, releaseOwnedLock } from "./locks.mjs";

function key(path) {
  const normalized = resolve(path).replaceAll("/", sep);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isWithin(parent, child) {
  const rel = relative(key(parent), key(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function canonicalDirectory(path) {
  const resolved = await realpath(resolve(path));
  if (!(await stat(resolved)).isDirectory()) throw new Error(`Not a directory: ${path}`);
  return resolved;
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function gitIdentity(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return { root: root ? await canonicalDirectory(root) : null, commonDir: common ? resolve(common) : null };
}

export class ProjectRegistry {
  constructor({ dataRoot, hubRoot, path } = {}) {
    this.dataRoot = resolve(dataRoot ?? hubRoot);
    this.path = path ? resolve(path) : resolve(this.dataRoot, "state", "projects.yaml");
    this.legacyPath = resolve(this.dataRoot, ".local", "projects.yaml");
  }

  async load() {
    let source = this.path;
    let text;
    try { text = await readFile(source, "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      source = this.legacyPath;
      try { text = await readFile(source, "utf8"); }
      catch (legacyError) { if (legacyError.code === "ENOENT") return { schema_version: 2, revision: 0, projects: [] }; throw legacyError; }
    }
    const parsed = parse(text, { maxAliasCount: 0, uniqueKeys: true });
    return { schema_version: 2, revision: parsed.revision ?? 0, projects: (parsed.projects ?? []).map(({ workspace_child, ...project }) => project), migrated_from: source === this.legacyPath ? source : undefined };
  }

  async inspect(projectPath) {
    const root = await canonicalDirectory(projectPath);
    const identity = await gitIdentity(root);
    const registry = await this.load();
    const exact = registry.projects.find((project) => key(project.root) === key(root));
    const repository = identity.commonDir ? registry.projects.find((project) => project.git_common_dir && key(project.git_common_dir) === key(identity.commonDir)) : null;
    const projectId = exact?.project_id ?? repository?.project_id ?? stableProjectId(identity.commonDir ?? root);
    return { projectId, projectRoot: root, cwd: root, gitRoot: identity.root, gitCommonDir: identity.commonDir, dataRoot: this.dataRoot, allowedRoots: [root], registryRevision: registry.revision, known: Boolean(exact || repository) };
  }

  async register(projectPath) {
    const binding = await this.resolve(projectPath, { admit: true });
    return { project_id: binding.projectId, root: binding.projectRoot, git_common_dir: binding.gitCommonDir, admitted_at: new Date().toISOString() };
  }

  async resolve(cwd, { admit = true } = {}) {
    const inspected = await this.inspect(cwd);
    if (!admit) return inspected;
    await assertMaintenanceInactive(this.dataRoot);
    const lock = await acquireOwnedLock(resolve(this.dataRoot, "state", "projects.lock"), { operation: "project-admit" }, "Project identity index is busy or has a stale lock");
    try {
      await assertMaintenanceInactive(this.dataRoot);
      const registry = await this.load();
      const existing = registry.projects.find((project) => key(project.root) === key(inspected.projectRoot));
      if (!existing) {
        registry.projects.push({ project_id: inspected.projectId, root: inspected.projectRoot, git_common_dir: inspected.gitCommonDir, admitted_at: new Date().toISOString() });
        registry.revision += 1;
        await writeRegistry(this.path, registry);
        await ensureProjectIgnore(inspected.projectRoot, inspected.gitRoot);
      }
      return { ...inspected, registryRevision: registry.revision, known: true };
    } finally { await releaseOwnedLock(lock); }
  }

  async registerRelocated({ projectId, projectPath, originalRoot = null, allowMaintenance = false }) {
    if (typeof projectId !== "string" || !projectId) throw new Error("Relocated project requires projectId");
    const inspected = await this.inspect(projectPath);
    if (!allowMaintenance) await assertMaintenanceInactive(this.dataRoot);
    const lock = await acquireOwnedLock(resolve(this.dataRoot, "state", "projects.lock"), { operation: "project-relocate" }, "Project identity index is busy or has a stale lock");
    try {
      const registry = await this.load();
      const atRoot = registry.projects.find((project) => key(project.root) === key(inspected.projectRoot));
      if (atRoot && atRoot.project_id !== projectId) throw new Error(`Relocation destination already belongs to ${atRoot.project_id}`);
      if (atRoot) return atRoot;
      const project = { project_id: projectId, root: inspected.projectRoot, git_common_dir: inspected.gitCommonDir, relocated_from: originalRoot, admitted_at: new Date().toISOString() };
      registry.projects.push(project);
      registry.revision += 1;
      await writeRegistry(this.path, registry);
      await ensureProjectIgnore(inspected.projectRoot, inspected.gitRoot);
      return project;
    } finally { await releaseOwnedLock(lock); }
  }
}

function stableProjectId(identity) {
  return `project-${createHash("sha256").update(key(identity)).digest("hex").slice(0, 12)}`;
}

async function writeRegistry(path, registry) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, stringify({ schema_version: 2, revision: registry.revision, projects: registry.projects }, { lineWidth: 0 }), { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

async function ensureProjectIgnore(root, gitRoot) {
  if (!gitRoot) return;
  const path = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  if (!path) return;
  let text = "";
  try { text = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (text.split(/\r?\n/).includes("/.codex-system/")) return;
  const prefix = text && !text.endsWith("\n") ? "\n" : "";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${text}${prefix}/.codex-system/\n`, "utf8");
}
