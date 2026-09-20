import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function runtimeRootFrom(metaUrl) {
  return resolve(dirname(fileURLToPath(metaUrl)), "..");
}

export function defaultDataRoot(env = process.env) {
  if (env.CODEX_SYSTEM_DATA_ROOT) return resolve(env.CODEX_SYSTEM_DATA_ROOT);
  return resolve(defaultCodexHome(env), "codex-system");
}

export function defaultCodexHome(env = process.env) {
  return resolve(env.CODEX_HOME || resolve(homedir(), ".codex"));
}

export function relayPointerPath(env = process.env) {
  return resolve(defaultCodexHome(env), "codex-system.json");
}

export function runtimeContext({ runtimeRoot, dataRoot = defaultDataRoot(), cwd = process.cwd(), projectRoot = cwd, allowedRoots = [projectRoot], releaseId = null }) {
  return { runtimeRoot: resolve(runtimeRoot), dataRoot: resolve(dataRoot), projectRoot: resolve(projectRoot), cwd: resolve(cwd), allowedRoots: allowedRoots.map((root) => resolve(root)), releaseId };
}
