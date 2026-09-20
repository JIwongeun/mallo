import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { findExecutable } from "./doctor.mjs";
import { relayPointerPath } from "./paths.mjs";

const PLUGIN = "codex-system";

export async function buildRelease({ sourceRoot, dataRoot, ref = "HEAD" }) {
  sourceRoot = await realpath(resolve(sourceRoot));
  const sourceSha = git(sourceRoot, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new Error(`Invalid Git ref: ${ref}`);
  if (sourceSha === git(sourceRoot, ["rev-parse", "HEAD"]).trim() && git(sourceRoot, ["status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("Refusing to build a dirty HEAD");
  const packageJson = JSON.parse(git(sourceRoot, ["show", `${sourceSha}:package.json`]));
  const pluginJson = JSON.parse(git(sourceRoot, ["show", `${sourceSha}:plugins/codex-system/.codex-plugin/plugin.json`]));
  const server = git(sourceRoot, ["show", `${sourceSha}:plugins/codex-system/server.mjs`]);
  const serverVersion = server.match(/serverInfo:\s*\{[^}]*version:\s*"([^"]+)"/)?.[1];
  if (pluginJson.version.split("+")[0] !== packageJson.version || serverVersion !== packageJson.version) throw new Error("Package, plugin, and server base versions must match");
  const releaseId = `${packageJson.version}-${sourceSha.slice(0, 12)}`;
  const releaseRoot = resolve(dataRoot, "releases", releaseId);
  try { await readFile(resolve(releaseRoot, "release-manifest.json")); throw new Error(`Release already exists: ${releaseId}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const staging = resolve(dataRoot, "releases", `.staging-${releaseId}-${process.pid}`);
  const archive = resolve(dataRoot, "releases", `.archive-${releaseId}-${process.pid}.tar`);
  await mkdir(dirname(staging), { recursive: true });
  try {
    git(sourceRoot, ["archive", "--format=tar", `--output=${archive}`, sourceSha, "package.json", "pnpm-lock.yaml", "src", "config", "plugins"]);
    await mkdir(staging, { recursive: true });
    command("tar", ["-xf", archive, "-C", staging], sourceRoot);
    const installedYaml = resolve(sourceRoot, "node_modules", "yaml");
    const yamlPackage = JSON.parse(await readFile(resolve(installedYaml, "package.json"), "utf8"));
    if (yamlPackage.version !== packageJson.dependencies?.yaml) throw new Error("Installed YAML dependency does not match package.json");
    await mkdir(resolve(staging, "node_modules"), { recursive: true });
    await cp(installedYaml, resolve(staging, "node_modules", "yaml"), { recursive: true, dereference: true, errorOnExist: true, force: false });
    const files = await fileManifest(staging);
    const manifest = {
      schema_version: 1,
      release_id: releaseId,
      source_sha: sourceSha,
      source_root: sourceRoot,
      base_version: packageJson.version,
      native_version: pluginJson.version,
      data_schema: { min: 2, max: 2 },
      node: packageJson.engines?.node ?? null,
      files,
      package_sha256: hash(JSON.stringify(files)),
      built_at: new Date().toISOString(),
    };
    await writeJsonAtomic(resolve(staging, "release-manifest.json"), manifest);
    await rename(staging, releaseRoot);
    const installation = await readInstallation(dataRoot);
    await writeInstallation(dataRoot, { ...installation, candidate: { release_id: releaseId, runtime_root: releaseRoot, source_sha: sourceSha, native_version: pluginJson.version, package_sha256: manifest.package_sha256 }, journal: { state: "built", updated_at: new Date().toISOString() } });
    return { ...manifest, runtime_root: releaseRoot };
  } finally {
    await rm(archive, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

export async function inspectRelease({ runtimeRoot }) {
  const root = await realpath(resolve(runtimeRoot));
  const manifest = JSON.parse(await readFile(resolve(root, "release-manifest.json"), "utf8"));
  const files = await fileManifest(root);
  const expected = JSON.stringify(manifest.files);
  const actual = JSON.stringify(files);
  if (expected !== actual || manifest.package_sha256 !== hash(actual)) throw new Error(`Release integrity check failed: ${manifest.release_id}`);
  return { release_id: manifest.release_id, runtime_root: root, source_sha: manifest.source_sha, native_version: manifest.native_version, package_sha256: manifest.package_sha256, files: files.length, verified: true };
}

export async function promoteRelease({ sourceRoot, dataRoot, runtimeRoot, runCommand = command }) {
  await assertIdle(dataRoot);
  const verified = await inspectRelease({ runtimeRoot });
  const manifest = JSON.parse(await readFile(resolve(runtimeRoot, "release-manifest.json"), "utf8"));
  sourceRoot = await realpath(resolve(sourceRoot));
  if (git(sourceRoot, ["rev-parse", "HEAD"]).trim() !== manifest.source_sha || git(sourceRoot, ["status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("Promotion requires the clean source commit used to build the candidate");
  const installation = await readInstallation(dataRoot);
  const previous = installation.active ?? null;
  await writeInstallation(dataRoot, { ...installation, previous, candidate: { ...verified }, journal: { state: "installing", updated_at: new Date().toISOString() } });
  const codexPath = await findExecutable("codex", process.env.CODEX_SYSTEM_CODEX_PATH);
  if (!codexPath) throw new Error("Codex executable is unavailable");
  let installResult;
  try {
    installResult = JSON.parse(runCommand(codexPath, ["plugin", "add", `${PLUGIN}@personal`, "--json"], sourceRoot).stdout);
    const pointer = pointerFor({ dataRoot, runtimeRoot, manifest });
    await writeJsonAtomic(relayPointerPath(), pointer);
    const startup = runCommand(pointer.node_path, [pointer.cli_path, "hook-context", "--cwd", sourceRoot], runtimeRoot, { ...process.env, CODEX_SYSTEM_DATA_ROOT: dataRoot });
    if (startup.status !== 0 || !startup.stdout.includes("RELAY:AVAILABLE")) throw new Error(`Promoted runtime failed startup: ${startup.stderr || startup.stdout}`);
    const active = { release_id: manifest.release_id, runtime_root: resolve(runtimeRoot), source_sha: manifest.source_sha, native_version: manifest.native_version, package_sha256: manifest.package_sha256, installed_path: installResult.installedPath ?? null, activated_at: new Date().toISOString() };
    await writeInstallation(dataRoot, { ...installation, active, previous, candidate: null, journal: { state: "active", updated_at: new Date().toISOString() }, native: installResult });
    return { active, previous, native: installResult, loaded_session_note: "New plugin snapshots require a new Codex task." };
  } catch (error) {
    if (previous?.runtime_root) await restorePointer(dataRoot, previous).catch(() => {});
    await writeInstallation(dataRoot, { ...installation, active: previous, previous: installation.previous ?? null, candidate: { ...verified }, journal: { state: "failed", error: error.message, updated_at: new Date().toISOString() } });
    throw error;
  }
}

export async function rollbackRelease({ dataRoot }) {
  await assertIdle(dataRoot);
  const installation = await readInstallation(dataRoot);
  if (!installation.previous?.runtime_root) throw new Error("No previous owned release is available");
  const target = installation.previous;
  if (target.release_id !== "legacy-0.1.1-c0e9438") await inspectRelease({ runtimeRoot: target.runtime_root });
  await restorePointer(dataRoot, target);
  const next = { ...installation, active: target, previous: installation.active, candidate: null, journal: { state: "active", action: "rollback", updated_at: new Date().toISOString() } };
  await writeInstallation(dataRoot, next);
  return { active: next.active, previous: next.previous, knowledge_preserved: true };
}

function pointerFor({ dataRoot, runtimeRoot, manifest }) {
  return {
    schema_version: 1,
    hub_root: resolve(dataRoot),
    runtime_root: resolve(runtimeRoot),
    data_root: resolve(dataRoot),
    node_path: process.execPath,
    cli_path: resolve(runtimeRoot, "src", "cli.mjs"),
    marketplace: "personal",
    plugin: PLUGIN,
    release_id: manifest.release_id,
    source_commit: manifest.source_sha,
    runtime_sha256: manifest.package_sha256,
    installed_at: new Date().toISOString(),
  };
}

async function restorePointer(dataRoot, release) {
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(release.runtime_root, "release-manifest.json"), "utf8")); }
  catch (error) {
    if (release.release_id !== "legacy-0.1.1-c0e9438") throw error;
    manifest = { release_id: release.release_id, source_sha: release.source_sha, package_sha256: release.package_sha256 };
  }
  await writeJsonAtomic(relayPointerPath(), pointerFor({ dataRoot, runtimeRoot: release.runtime_root, manifest }));
}

async function fileManifest(root) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (relative(root, child).replaceAll("\\", "/") !== "release-manifest.json") files.push({ path: relative(root, child).replaceAll("\\", "/"), sha256: hash(await readFile(child)) });
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function assertIdle(dataRoot) {
  const root = resolve(dataRoot, "state", "locks");
  let names = [];
  try { names = (await readdir(root)).filter((name) => name.endsWith(".lock")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const active = [];
  for (const name of names) {
    try {
      const lock = JSON.parse(await readFile(resolve(root, name), "utf8"));
      if (isProcessAlive(lock.pid)) active.push(name);
    } catch { active.push(name); }
  }
  if (active.length) throw new Error(`Active managed runs block release changes: ${active.join(", ")}`);
}

async function readInstallation(dataRoot) {
  try { return JSON.parse(await readFile(resolve(dataRoot, "installation.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { schema_version: 1, active: null, previous: null, candidate: null, journal: null }; throw error; }
}

async function writeInstallation(dataRoot, value) {
  await writeJsonAtomic(resolve(dataRoot, "installation.json"), { schema_version: 1, ...value });
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

function git(cwd, args) { return command("git", ["-C", cwd, ...args], cwd).stdout; }

function command(executable, args, cwd, env = process.env) {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", windowsHide: true, shell: false, timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`Command failed: ${executable} ${args.join(" ")}\n${result.stderr || result.stdout || result.error?.message}`);
  return result;
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
