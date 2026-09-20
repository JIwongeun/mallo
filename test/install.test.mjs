import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { uninstallIntegration } from "../src/install.mjs";
import { spawnSync } from "node:child_process";

test("uninstall removes only Relay integration and preserves personal data", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-uninstall-"));
  const previousHome = process.env.CODEX_HOME;
  const previousExecutable = process.env.CODEX_SYSTEM_CODEX_PATH;
  process.env.CODEX_HOME = resolve(root, "home");
  process.env.CODEX_SYSTEM_CODEX_PATH = process.execPath;
  try {
    const dataRoot = resolve(root, "home", "codex-system");
    await mkdir(resolve(dataRoot, "knowledge"), { recursive: true });
    await writeFile(resolve(dataRoot, "knowledge", "user.yaml"), "preserve: true\n");
    await writeFile(resolve(root, "home", "codex-system.json"), JSON.stringify({ schema_version: 1, hub_root: dataRoot, data_root: dataRoot }));
    const calls = [];
    const runCommand = (_executable, args) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify(args[1] === "list" ? { installed: [{ pluginId: "codex-system@personal" }, { pluginId: "other@personal" }] } : { removed: true }) };
    };
    const result = await uninstallIntegration(root, { dataRoot, runCommand });
    assert.equal(result.plugin, "removed");
    assert.ok(calls.some((args) => args[1] === "remove" && args[2] === "codex-system@personal"));
    assert.equal(await readFile(resolve(dataRoot, "knowledge", "user.yaml"), "utf8"), "preserve: true\n");
    await assert.rejects(readFile(resolve(root, "home", "codex-system.json")), /ENOENT/);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousExecutable === undefined) delete process.env.CODEX_SYSTEM_CODEX_PATH; else process.env.CODEX_SYSTEM_CODEX_PATH = previousExecutable;
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall refuses a pointer owned by another data root", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-uninstall-owner-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = resolve(root, "home");
  try {
    await mkdir(process.env.CODEX_HOME, { recursive: true });
    await writeFile(resolve(process.env.CODEX_HOME, "codex-system.json"), JSON.stringify({ schema_version: 1, data_root: resolve(root, "other") }));
    await assert.rejects(uninstallIntegration(root, { dataRoot: resolve(root, "expected") }), /not owned/);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("session hook resolves the pointer from an active custom CODEX_HOME", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-hook-경로-"));
  try {
    const codexHome = resolve(root, "custom home");
    const cli = resolve(root, "fake-cli.mjs");
    await mkdir(codexHome, { recursive: true });
    await writeFile(cli, "console.log(process.env.CODEX_SYSTEM_DATA_ROOT ? 'CUSTOM_HOME_OK' : 'MISSING_DATA_ROOT')\n");
    await writeFile(resolve(codexHome, "codex-system.json"), `${JSON.stringify({ schema_version: 1, hub_root: root, data_root: root, node_path: process.execPath, cli_path: cli })}\n`);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("plugins", "codex-system", "scripts", "session-context.ps1")], { cwd: root, env: { ...process.env, CODEX_HOME: codexHome }, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "CUSTOM_HOME_OK");
  } finally { await rm(root, { recursive: true, force: true }); }
});
