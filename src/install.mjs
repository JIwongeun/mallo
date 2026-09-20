import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { findExecutable } from "./doctor.mjs";

const PLUGIN = "codex-system";

export async function installIntegration(hubRoot, { runCommand = run } = {}) {
  const codexPath = await findExecutable("codex", process.env.CODEX_SYSTEM_CODEX_PATH);
  if (!codexPath) throw new Error("Codex executable is unavailable");
  const marketplace = JSON.parse(await readFile(resolve(hubRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
  const marketplaceName = marketplace.name;
  if (!/^[A-Za-z0-9_-]+$/.test(marketplaceName)) throw new Error("Invalid marketplace name");
  const pointerPath = resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"), "codex-system.json");
  let previous = null;
  try { previous = JSON.parse(await readFile(resolve(hubRoot, ".local", "install-receipt.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  try {
    const text = await readFile(pointerPath, "utf8");
    if (previous?.pointer_sha256 !== hash(text)) throw new Error("Existing Codex System pointer is not owned or was modified; preserve it and resolve the conflict before installation");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const listed = parseJson(runCommand(codexPath, ["plugin", "marketplace", "list", "--json"]).stdout);
  if (!Array.isArray(listed.marketplaces)) throw new Error("Invalid native marketplace inventory");
  const existing = listed.marketplaces.find((entry) => entry.name === marketplaceName);
  if (existing && pathKey(existing.root) !== pathKey(hubRoot)) throw new Error(`Marketplace ${marketplaceName} belongs to another root`);
  if (!existing) {
    runCommand(codexPath, ["plugin", "marketplace", "add", resolve(hubRoot), "--json"]);
  }
  const inventory = parseJson(runCommand(codexPath, ["plugin", "list", "--json"]).stdout);
  if (!Array.isArray(inventory.installed)) throw new Error("Invalid native plugin inventory");
  const alreadyInstalled = inventory.installed.find((entry) => entry.pluginId === `${PLUGIN}@${marketplaceName}`);
  if (alreadyInstalled && pathKey(alreadyInstalled.source?.path ?? "") !== pathKey(resolve(hubRoot, "plugins", PLUGIN))) throw new Error("Installed plugin belongs to another source");
  const installed = runCommand(codexPath, ["plugin", "add", `${PLUGIN}@${marketplaceName}`, "--json"]);
  const installResult = parseJson(installed.stdout);
  for (const dir of ["workspace", "brain", ".local"]) await mkdir(resolve(hubRoot, dir), { recursive: true });
  const pointer = {
    schema_version: 1,
    hub_root: resolve(hubRoot),
    node_path: process.execPath,
    cli_path: resolve(hubRoot, "src", "cli.mjs"),
    marketplace: marketplaceName,
    plugin: PLUGIN,
    installed_at: new Date().toISOString(),
  };
  await mkdir(dirname(pointerPath), { recursive: true });
  await writeJsonAtomic(pointerPath, pointer);
  const receipt = {
    schema_version: 1,
    pointer_path: pointerPath,
    pointer_sha256: hash(JSON.stringify(pointer, null, 2) + "\n"),
    marketplace_owned: previous?.marketplace_owned ?? !existing,
    plugin_owned: previous?.plugin_owned ?? (Boolean(previous) || !alreadyInstalled),
    hub_root: resolve(hubRoot),
    marketplace: marketplaceName,
    plugin: PLUGIN,
    source_hash: await hashTree(resolve(hubRoot, "plugins", PLUGIN)),
    installed_hash: installResult.installedPath ? await hashTree(resolve(installResult.installedPath)) : null,
    install_result: installResult,
    installed_at: pointer.installed_at,
  };
  await writeJsonAtomic(resolve(hubRoot, ".local", "install-receipt.json"), receipt);
  return receipt;
}

export async function uninstallIntegration(hubRoot, { runCommand = run } = {}) {
  const receiptPath = resolve(hubRoot, ".local", "install-receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const codexPath = await findExecutable("codex", process.env.CODEX_SYSTEM_CODEX_PATH);
  if (!codexPath) throw new Error("Codex executable is unavailable");
  const inventory = parseJson(runCommand(codexPath, ["plugin", "list", "--json"]).stdout);
  if (!Array.isArray(inventory.installed)) throw new Error("Invalid native plugin inventory");
  const current = inventory.installed.find((entry) => entry.pluginId === `${receipt.plugin}@${receipt.marketplace}`);
  const sourceUnchanged = await hashTree(resolve(hubRoot, "plugins", PLUGIN)) === receipt.source_hash;
  const cacheUnchanged = !receipt.installed_hash || await hashTree(resolve(receipt.install_result?.installedPath ?? "")).catch(() => null) === receipt.installed_hash;
  const owned = receipt.plugin_owned !== false && sourceUnchanged && cacheUnchanged && current?.version === receipt.install_result?.version && pathKey(current?.source?.path ?? "") === pathKey(resolve(hubRoot, "plugins", PLUGIN));
  let plugin = current ? "preserved_modified_or_unowned" : "already_absent";
  if (owned) { runCommand(codexPath, ["plugin", "remove", `${receipt.plugin}@${receipt.marketplace}`, "--json"]); plugin = "removed"; }
  // A marketplace can acquire unrelated plugins after installation. Keep the harmless
  // registration rather than deleting a shared namespace during plugin removal.
  let pointer = "missing";
  try {
    const text = await readFile(receipt.pointer_path, "utf8");
    if (hash(text) === receipt.pointer_sha256) {
      await rm(receipt.pointer_path);
      pointer = "removed";
    } else pointer = "preserved_modified";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const result = { plugin, marketplace: "preserved", pointer, data_preserved: [resolve(hubRoot, "brain"), resolve(hubRoot, ".local", "projects.yaml"), resolve(hubRoot, "workspace")] };
  await writeJsonAtomic(resolve(hubRoot, ".local", "uninstall-receipt.json"), { schema_version: 1, ...result, uninstalled_at: new Date().toISOString() });
  return result;
}

function run(executable, args, { allowFailure = false } = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000 });
  if (!allowFailure && result.status !== 0) throw new Error(`Command failed: codex ${args.join(" ")}\n${result.stderr || result.stdout}`);
  return result;
}

async function hashTree(root) {
  const entries = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else entries.push([relative(root, child).replaceAll("\\", "/"), hash(await readFile(child))]);
    }
  }
  await visit(root);
  return hash(JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b))));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pathKey(path) {
  const key = resolve(path.replace(/^\\\\\?\\/, ""));
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return { raw: text.trim() }; }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
  await import("node:fs/promises").then(({ rename }) => rename(temporary, path));
}
