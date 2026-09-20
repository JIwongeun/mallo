import test from "node:test";
import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildRelease, inspectRelease, promoteRelease, rollbackRelease } from "../src/release.mjs";

test("Mallo branding, entry skill, assets, and versions stay consistent", async () => {
  const manifest = JSON.parse(await readFile(resolve("plugins/codex-system/.codex-plugin/plugin.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const skill = await readFile(resolve("plugins/codex-system/skills/mallo/SKILL.md"), "utf8");
  const hooks = await readFile(resolve("plugins/codex-system/hooks/hooks.json"), "utf8");
  const config = await readFile(resolve("config/skills.yaml"), "utf8");
  const readme = await readFile(resolve("README.md"), "utf8");
  const server = await readFile(resolve("plugins/codex-system/server.mjs"), "utf8");
  const client = await readFile(resolve("src/codex.mjs"), "utf8");
  const mascot = await readFile(resolve("plugins/codex-system/assets/mallo.png"));
  assert.equal(packageJson.version, "0.2.1");
  assert.equal(manifest.version.split("+")[0], "0.2.1");
  assert.equal(manifest.interface.displayName, "Mallo");
  assert.match(manifest.description, /small, formless companion.*verified lessons/);
  assert.deepEqual([manifest.interface.composerIcon, manifest.interface.logo, manifest.interface.logoDark], Array(3).fill("./assets/mallo.png"));
  assert.equal(createHash("sha256").update(mascot).digest("hex").toUpperCase(), "E6119BD24978C2D32DE0C8E643B47546C2B0B6ECC785C39A8DC07FA58A8BE4B9");
  assert.match(skill, /^name: mallo$/m);
  assert.match(hooks, /Checking Mallo availability/);
  assert.match(config, /codex-system:mallo/);
  assert.match(config, /plugin:codex-system:skills\/mallo/);
  assert.match(readme, /^경험을 먹고, 당신에게 맞춰지는 작은 생물\.$/m);
  assert.match(server, /serverInfo: \{ name: "codex-system", version: "0\.2\.1" \}/);
  assert.match(client, /clientInfo: \{ name: "mallo", title: "Mallo", version: "0\.2\.1" \}/);
  for (const obsolete of ["plugins/codex-system/skills/relay/SKILL.md", "plugins/codex-system/assets/relay-icon.png", "plugins/codex-system/assets/relay-logo.png", "plugins/codex-system/assets/relay-logo-dark.png"]) await assert.rejects(access(resolve(obsolete)));
});

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
    const unavailable = resolve(root, "source-unavailable");
    const project = resolve(root, "project");
    await mkdir(project);
    await rename(source, unavailable);
    const startup = spawnSync(process.execPath, [resolve(built.runtime_root, "src", "cli.mjs"), "hook-context", "--cwd", project], {
      cwd: project,
      env: { ...process.env, CODEX_SYSTEM_DATA_ROOT: data },
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(startup.status, 0, startup.stderr);
    assert.match(startup.stdout, /RELAY:AVAILABLE/);
    assert.match(startup.stdout, /Mallo is available/);
    assert.match(startup.stdout, /mallo skill/);
    await rename(unavailable, source);
    await writeFile(resolve(built.runtime_root, "config", "routing.yaml"), "tampered: true\n");
    await assert.rejects(inspectRelease({ runtimeRoot: built.runtime_root }), /integrity/);
    await writeFile(resolve(source, "README-dirty.md"), "untracked is ignored by the committed build\n");
    await writeFile(resolve(source, "package.json"), `${await readFile(resolve(source, "package.json"), "utf8")} `);
    await assert.rejects(buildRelease({ sourceRoot: source, dataRoot: resolve(root, "other"), ref: "HEAD" }), /dirty HEAD/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release build CLI prints a compact result while persisting the full manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-release-cli-"));
  try {
    const source = await fixtureSource(resolve(root, "source"));
    const data = resolve(root, "data");
    const result = spawnSync(process.execPath, [resolve(source, "src", "cli.mjs"), "release", "build", "--ref", "HEAD"], {
      cwd: source,
      env: { ...process.env, CODEX_HOME: resolve(root, "home"), CODEX_SYSTEM_DATA_ROOT: data },
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const manifest = JSON.parse(await readFile(resolve(output.runtime_root, "release-manifest.json"), "utf8"));
    assert.equal(Object.hasOwn(output, "files"), false);
    assert.equal(output.file_count, manifest.files.length);
    assert.ok(manifest.files.length > 0);
    assert.equal(output.package_sha256, manifest.package_sha256);
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
      if (args[0] === "plugin") return { status: 0, stdout: JSON.stringify({ version: "0.2.1", installedPath: resolve(root, "cache") }), stderr: "" };
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
