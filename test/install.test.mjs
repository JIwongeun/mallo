import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { installIntegration, uninstallIntegration } from "../src/install.mjs";
import { spawnSync } from "node:child_process";

test("installer preserves modified pointers and unrelated marketplace members", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-install-review-"));
  const previousHome = process.env.CODEX_HOME;
  const previousExecutable = process.env.CODEX_SYSTEM_CODEX_PATH;
  process.env.CODEX_HOME = resolve(root, "home");
  process.env.CODEX_SYSTEM_CODEX_PATH = process.execPath;
  try {
    await mkdir(resolve(root, ".agents", "plugins"), { recursive: true });
    await mkdir(resolve(root, "plugins", "codex-system"), { recursive: true });
    await writeFile(resolve(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(resolve(root, "plugins", "codex-system", "test.txt"), "plugin");
    const calls = [];
    let installed = [];
    const runCommand = (_executable, args) => {
      calls.push(args);
      let result = {};
      if (args[1] === "marketplace" && args[2] === "list") result = { marketplaces: [{ name: "fixture", root }] };
      if (args[1] === "list") result = { installed };
      if (args[1] === "add") {
        installed = [{ pluginId: "codex-system@fixture", source: { path: resolve(root, "plugins", "codex-system") }, version: "test" }, { pluginId: "another@fixture" }];
        result = { version: "test" };
      }
      return { stdout: JSON.stringify(result), status: 0 };
    };
    const receipt = await installIntegration(root, { runCommand });
    assert.equal(receipt.plugin_owned, true);
    assert.equal(receipt.marketplace_owned, false);
    const pointer = resolve(root, "home", "codex-system.json");
    const original = await readFile(pointer, "utf8");
    await writeFile(pointer, original + " ");
    await assert.rejects(installIntegration(root, { runCommand }), /was modified/);
    const result = await uninstallIntegration(root, { runCommand });
    assert.equal(result.pointer, "preserved_modified");
    assert.equal(result.marketplace, "preserved");
    assert.ok(calls.some((args) => args[1] === "remove" && args[2] === "codex-system@fixture"));
    assert.ok(!calls.some((args) => args[1] === "marketplace" && args[2] === "remove"));
    assert.equal(await readFile(pointer, "utf8"), original + " ");
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousExecutable === undefined) delete process.env.CODEX_SYSTEM_CODEX_PATH; else process.env.CODEX_SYSTEM_CODEX_PATH = previousExecutable;
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstaller preserves a plugin whose source changed after installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-install-source-review-"));
  const previousHome = process.env.CODEX_HOME;
  const previousExecutable = process.env.CODEX_SYSTEM_CODEX_PATH;
  process.env.CODEX_HOME = resolve(root, "home");
  process.env.CODEX_SYSTEM_CODEX_PATH = process.execPath;
  try {
    await mkdir(resolve(root, ".agents", "plugins"), { recursive: true });
    await mkdir(resolve(root, "plugins", "codex-system"), { recursive: true });
    await writeFile(resolve(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(resolve(root, "plugins", "codex-system", "test.txt"), "original");
    let installed = [];
    const calls = [];
    const runCommand = (_executable, args) => {
      calls.push(args);
      let result = {};
      if (args[1] === "marketplace" && args[2] === "list") result = { marketplaces: [{ name: "fixture", root }] };
      if (args[1] === "list") result = { installed };
      if (args[1] === "add") { installed = [{ pluginId: "codex-system@fixture", source: { path: resolve(root, "plugins", "codex-system") }, version: "test" }]; result = { version: "test" }; }
      return { stdout: JSON.stringify(result), status: 0 };
    };
    await installIntegration(root, { runCommand });
    await writeFile(resolve(root, "plugins", "codex-system", "test.txt"), "modified");
    const result = await uninstallIntegration(root, { runCommand });
    assert.equal(result.plugin, "preserved_modified_or_unowned");
    assert.ok(!calls.some((args) => args[1] === "remove"));
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousExecutable === undefined) delete process.env.CODEX_SYSTEM_CODEX_PATH; else process.env.CODEX_SYSTEM_CODEX_PATH = previousExecutable;
    await rm(root, { recursive: true, force: true });
  }
});

test("session hook resolves the pointer from an active custom CODEX_HOME", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-hook-경로-"));
  try {
    const codexHome = resolve(root, "custom home");
    const cli = resolve(root, "fake-cli.mjs");
    await mkdir(codexHome, { recursive: true });
    await writeFile(cli, "console.log('CUSTOM_HOME_OK')\n");
    await writeFile(resolve(codexHome, "codex-system.json"), `${JSON.stringify({ schema_version: 1, hub_root: root, node_path: process.execPath, cli_path: cli })}\n`);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("plugins", "codex-system", "scripts", "session-context.ps1")], { cwd: root, env: { ...process.env, CODEX_HOME: codexHome }, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "CUSTOM_HOME_OK");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uninstaller preserves a changed native cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-install-cache-review-"));
  const previousHome = process.env.CODEX_HOME;
  const previousExecutable = process.env.CODEX_SYSTEM_CODEX_PATH;
  process.env.CODEX_HOME = resolve(root, "home");
  process.env.CODEX_SYSTEM_CODEX_PATH = process.execPath;
  try {
    const source = resolve(root, "plugins", "codex-system");
    const cache = resolve(root, "cache", "codex-system");
    await mkdir(resolve(root, ".agents", "plugins"), { recursive: true });
    await mkdir(source, { recursive: true });
    await mkdir(cache, { recursive: true });
    await writeFile(resolve(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(resolve(source, "test.txt"), "source");
    await writeFile(resolve(cache, "test.txt"), "cached");
    let installed = [];
    const calls = [];
    const runCommand = (_executable, args) => {
      calls.push(args);
      let result = {};
      if (args[1] === "marketplace" && args[2] === "list") result = { marketplaces: [{ name: "fixture", root }] };
      if (args[1] === "list") result = { installed };
      if (args[1] === "add") { installed = [{ pluginId: "codex-system@fixture", source: { path: source }, version: "test" }]; result = { version: "test", installedPath: cache }; }
      return { stdout: JSON.stringify(result), status: 0 };
    };
    await installIntegration(root, { runCommand });
    await writeFile(resolve(cache, "test.txt"), "changed cache");
    assert.equal((await uninstallIntegration(root, { runCommand })).plugin, "preserved_modified_or_unowned");
    assert.ok(!calls.some((args) => args[1] === "remove"));
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousExecutable === undefined) delete process.env.CODEX_SYSTEM_CODEX_PATH; else process.env.CODEX_SYSTEM_CODEX_PATH = previousExecutable;
    await rm(root, { recursive: true, force: true });
  }
});
