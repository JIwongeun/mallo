import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
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
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function gitIdentity(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return { root: root ? await canonicalDirectory(root) : null, commonDir: common ? resolve(common) : null };
}

export class ProjectRegistry {
  constructor({ hubRoot, path = resolve(hubRoot, ".local", "projects.yaml") }) {
    this.hubRoot = resolve(hubRoot);
    this.path = path;
  }

  async load() {
    try {
      const parsed = parse(await readFile(this.path, "utf8"), { maxAliasCount: 0, uniqueKeys: true });
      return { schema_version: 1, revision: parsed.revision ?? 0, projects: parsed.projects ?? [] };
    } catch (error) {
      if (error.code === "ENOENT") return { schema_version: 1, revision: 0, projects: [] };
      throw error;
    }
  }

  async register(projectPath) {
    const root = await canonicalDirectory(projectPath);
    if (key(root) === key(this.hubRoot)) throw new Error("The hub is not registered as a child project");
    await assertMaintenanceInactive(this.hubRoot);
    const lock = await acquireOwnedLock(resolve(this.hubRoot, ".local", "projects.lock"), { operation: "project-register" }, "Project registry is busy or has a stale lock");
    try {
      await assertMaintenanceInactive(this.hubRoot);
      const workspace = resolve(this.hubRoot, "workspace");
      const registry = await this.load();
      const existing = registry.projects.find((project) => key(project.root) === key(root));
      if (existing) return existing;
      const identity = await gitIdentity(root);
      const repository = identity.commonDir
        ? registry.projects.find((entry) => entry.git_common_dir && key(entry.git_common_dir) === key(identity.commonDir))
        : null;
      const project = {
        project_id: repository?.project_id ?? `project-${createHash("sha256").update(`${root}\0${randomUUID()}`).digest("hex").slice(0, 12)}`,
        root,
        git_common_dir: identity.commonDir,
        workspace_child: isWithin(workspace, root),
        registered_at: new Date().toISOString(),
      };
      registry.projects.push(project);
      registry.revision += 1;
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, stringify(registry, { lineWidth: 0 }), { encoding: "utf8", flag: "wx" });
      await import("node:fs/promises").then(({ rename }) => rename(temporary, this.path));
      await ensureProjectIgnore(root);
      return project;
    } finally { await releaseOwnedLock(lock); }
  }

  async resolve(cwd) {
    const canonicalCwd = await canonicalDirectory(cwd);
    const registry = await this.load();
    const candidates = registry.projects.filter((project) => isWithin(project.root, canonicalCwd));
    candidates.sort((a, b) => b.root.length - a.root.length);
    if (candidates.length === 0) throw new Error(`Current directory is not a registered project: ${canonicalCwd}`);
    if (candidates.length > 1 && candidates[0].root.length === candidates[1].root.length) throw new Error(`Project binding is ambiguous: ${canonicalCwd}`);
    const project = candidates[0];
    const currentIdentity = await gitIdentity(canonicalCwd);
    if (project.git_common_dir && (!currentIdentity.commonDir || key(project.git_common_dir) !== key(currentIdentity.commonDir))) {
      throw new Error(`Git identity changed for registered project ${project.project_id}`);
    }
    if (currentIdentity.root && isWithin(project.root, currentIdentity.root) && key(currentIdentity.root) !== key(project.root)) throw new Error("Nested Git repository must be registered separately");
    return {
      projectId: project.project_id,
      projectRoot: project.root,
      cwd: canonicalCwd,
      gitCommonDir: currentIdentity.commonDir,
      hubRoot: this.hubRoot,
      registryRevision: registry.revision,
    };
  }

  async registerRelocated({ projectId, projectPath, originalRoot = null, allowMaintenance = false }) {
    if (typeof projectId !== "string" || !projectId) throw new Error("Relocated project requires projectId");
    const root = await canonicalDirectory(projectPath);
    if (!allowMaintenance) await assertMaintenanceInactive(this.hubRoot);
    const lock = await acquireOwnedLock(resolve(this.hubRoot, ".local", "projects.lock"), { operation: "project-relocate" }, "Project registry is busy or has a stale lock");
    try {
      if (!allowMaintenance) await assertMaintenanceInactive(this.hubRoot);
      const registry = await this.load();
      const atRoot = registry.projects.find((project) => key(project.root) === key(root));
      if (atRoot && atRoot.project_id !== projectId) throw new Error(`Relocation destination already belongs to ${atRoot.project_id}`);
      if (atRoot) return atRoot;
      const identity = await gitIdentity(root);
      const project = {
        project_id: projectId,
        root,
        git_common_dir: identity.commonDir,
        workspace_child: isWithin(resolve(this.hubRoot, "workspace"), root),
        relocated_from: originalRoot,
        registered_at: new Date().toISOString(),
      };
      registry.projects.push(project);
      registry.revision += 1;
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, stringify(registry, { lineWidth: 0 }), { encoding: "utf8", flag: "wx" });
      await import("node:fs/promises").then(({ rename }) => rename(temporary, this.path));
      await ensureProjectIgnore(root);
      return project;
    } finally { await releaseOwnedLock(lock); }
  }
}

async function ensureProjectIgnore(root) {
  const path = resolve(root, ".gitignore");
  let text = "";
  try { text = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (text.split(/\r?\n/).includes("/.codex-system/")) return;
  const prefix = text && !text.endsWith("\n") ? "\n" : "";
  await writeFile(path, `${text}${prefix}/.codex-system/\n`, "utf8");
}
