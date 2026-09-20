import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildRelease, inspectRelease, promoteRelease, rollbackRelease } from "../src/release.mjs";

test("release build uses an exact clean commit and detects tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-release-build-"));
  try {
    const source = await fixtureSource(resolve(root, "source"));
    const data = resolve(root, "data");
    await mkdir(data, { recursive: true });
    await writeFile(resolve(data, "installation.json"), JSON.stringify({ schema_version: 1, active: { release_id: "existing", runtime_root: "existing" }, previous: null }));
    const built = await buildRelease({ sourceRoot: source, dataRoot: data, ref: "HEAD" });
    const installation = JSON.parse(await readFile(resolve(data, "installation.json"), "utf8"));
    assert.equal(installation.active.release_id, "existing");
    assert.equal(installation.candidate.release_id, built.release_id);
    assert.equal((await inspectRelease({ runtimeRoot: built.runtime_root })).source_sha, built.source_sha);
    await writeFile(resolve(built.runtime_root, "config", "routing.yaml"), "tampered: true\n");
    await assert.rejects(inspectRelease({ runtimeRoot: built.runtime_root }), /integrity/);
    await writeFile(resolve(source, "README-dirty.md"), "untracked is ignored by the committed build\n");
    await writeFile(resolve(source, "package.json"), `${await readFile(resolve(source, "package.json"), "utf8")} `);
    await assert.rejects(buildRelease({ sourceRoot: source, dataRoot: resolve(root, "other"), ref: "HEAD" }), /dirty HEAD/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("promotion records the previous release and rollback preserves Knowledge", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-release-promote-"));
  const priorHome = process.env.CODEX_HOME;
  const priorCodex = process.env.CODEX_SYSTEM_CODEX_PATH;
  process.env.CODEX_HOME = resolve(root, "home");
  process.env.CODEX_SYSTEM_CODEX_PATH = process.execPath;
  try {
    const source = await fixtureSource(resolve(root, "source"));
    const data = resolve(process.env.CODEX_HOME, "codex-system");
    const built = await buildRelease({ sourceRoot: source, dataRoot: data, ref: "HEAD" });
    const legacyRoot = resolve(root, "legacy");
    await mkdir(resolve(legacyRoot, "src"), { recursive: true });
    await mkdir(resolve(data, "knowledge"), { recursive: true });
    await writeFile(resolve(data, "knowledge", "personal.txt"), "keep\n");
    await writeFile(resolve(data, "installation.json"), JSON.stringify({ schema_version: 1, active: { release_id: "legacy-0.1.1-c0e9438", runtime_root: legacyRoot, source_sha: "legacy", package_sha256: "legacy" }, previous: null }));
    const calls = [];
    const runCommand = (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "plugin") return { status: 0, stdout: JSON.stringify({ version: "0.2.0", installedPath: resolve(root, "cache") }), stderr: "" };
      return { status: 0, stdout: '{"systemMessage":"RELAY:AVAILABLE"}', stderr: "" };
    };
    const promoted = await promoteRelease({ sourceRoot: source, dataRoot: data, runtimeRoot: built.runtime_root, runCommand });
    assert.equal(promoted.active.release_id, built.release_id);
    assert.equal(promoted.previous.release_id, "legacy-0.1.1-c0e9438");
    const pointer = JSON.parse(await readFile(resolve(process.env.CODEX_HOME, "codex-system.json"), "utf8"));
    assert.equal(pointer.runtime_root, built.runtime_root);
    assert.equal(pointer.data_root, data);
    assert.ok(calls.some(({ args }) => args[0] === "plugin" && args[1] === "add"));
    const rolledBack = await rollbackRelease({ dataRoot: data });
    assert.equal(rolledBack.active.release_id, "legacy-0.1.1-c0e9438");
    assert.equal(await readFile(resolve(data, "knowledge", "personal.txt"), "utf8"), "keep\n");
    await mkdir(resolve(data, "state", "locks"), { recursive: true });
    const lock = resolve(data, "state", "locks", "active.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid }));
    await assert.rejects(rollbackRelease({ dataRoot: data }), /Active managed runs/);
    await unlink(lock);
  } finally {
    if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
    if (priorCodex === undefined) delete process.env.CODEX_SYSTEM_CODEX_PATH; else process.env.CODEX_SYSTEM_CODEX_PATH = priorCodex;
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureSource(destination) {
  await mkdir(destination, { recursive: true });
  for (const name of ["package.json", "pnpm-lock.yaml", "src", "config", "plugins"]) await cp(resolve(name), resolve(destination, name), { recursive: true });
  await mkdir(resolve(destination, "node_modules"), { recursive: true });
  await cp(resolve("node_modules", "yaml"), resolve(destination, "node_modules", "yaml"), { recursive: true, dereference: true });
  for (const args of [["init"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "Fixture"], ["add", "package.json", "pnpm-lock.yaml", "src", "config", "plugins"], ["commit", "-m", "fixture"]]) {
    const result = spawnSync("git", ["-C", destination, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  return destination;
}
