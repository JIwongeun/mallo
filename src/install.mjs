import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { findExecutable } from "./doctor.mjs";
import { promoteRelease } from "./release.mjs";
import { relayPointerPath } from "./paths.mjs";

export async function installIntegration(sourceRoot, { dataRoot, runtimeRoot, runCommand } = {}) {
  if (!dataRoot || !runtimeRoot) throw new Error("Install requires explicit dataRoot and a verified runtimeRoot");
  return promoteRelease({ sourceRoot, dataRoot, runtimeRoot, ...(runCommand ? { runCommand } : {}) });
}

export async function uninstallIntegration(_sourceRoot, { dataRoot, runCommand = run } = {}) {
  if (!dataRoot) throw new Error("Uninstall requires explicit dataRoot");
  const pointerPath = relayPointerPath();
  let pointer = null;
  try { pointer = JSON.parse(await readFile(pointerPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (pointer && resolve(pointer.data_root ?? pointer.hub_root) !== resolve(dataRoot)) throw new Error("Mallo pointer is not owned by this data root");
  const codexPath = await findExecutable("codex", process.env.CODEX_SYSTEM_CODEX_PATH);
  if (!codexPath) throw new Error("Codex executable is unavailable");
  const inventory = JSON.parse(runCommand(codexPath, ["plugin", "list", "--json"]).stdout);
  const current = inventory.installed?.find((entry) => entry.pluginId === "codex-system@personal");
  if (current) runCommand(codexPath, ["plugin", "remove", "codex-system@personal", "--json"]);
  if (pointer) await rm(pointerPath);
  return { plugin: current ? "removed" : "already_absent", pointer: pointer ? "removed" : "missing", data_preserved: [resolve(dataRoot, "knowledge"), resolve(dataRoot, "settings.yaml"), resolve(dataRoot, "state")] };
}

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`Command failed: ${executable} ${args.join(" ")}\n${result.stderr || result.stdout || result.error?.message}`);
  return result;
}
