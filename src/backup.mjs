import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { isWithin } from "./bindings.mjs";
import { rebuildKnowledge } from "./knowledge.mjs";
import { acquireOwnedLock, releaseOwnedLock } from "./locks.mjs";

export async function exportBackup({ hubRoot: dataRoot, destination }) {
  const maintenance = await acquireOwnedLock(resolve(dataRoot, "state", "maintenance.lock"), { operation: "backup-export" }, "Mallo maintenance is already active");
  try {
    await assertQuiescent(dataRoot);
    const root = resolve(destination);
    if (isWithin(dataRoot, root)) throw new Error("Backup destination must be outside Mallo data");
    await mkdir(root, { recursive: true });
    if ((await readdir(root)).length) throw new Error("Backup destination must be empty");
    const items = [];
    await copyYamlTree(resolve(dataRoot, "knowledge", "patterns"), resolve(root, "knowledge", "patterns"), items, root);
    await copyOptional(resolve(dataRoot, "settings.yaml"), resolve(root, "settings.yaml"), items, root);
    await assertQuiescent(dataRoot);
    for (const item of items) if (hash(await readFile(item.source)) !== item.sha256) throw new Error(`Source changed during backup: ${item.path}`);
    const manifest = { schema_version: 2, created_at: new Date().toISOString(), items: items.map(({ source, ...item }) => item), data_schema: { knowledge: 2 } };
    await writeFile(resolve(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return manifest;
  } finally { await releaseOwnedLock(maintenance); }
}

export async function importBackup({ hubRoot: dataRoot, source }) {
  const maintenance = await acquireOwnedLock(resolve(dataRoot, "state", "maintenance.lock"), { operation: "backup-import" }, "Mallo maintenance is already active");
  try {
    await assertQuiescent(dataRoot);
    const root = await realpath(resolve(source));
    const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
    if (manifest.schema_version !== 2 || !Array.isArray(manifest.items) || manifest.items.length > 50_000) throw new Error("Unsupported backup manifest");
    const pending = [];
    for (const item of manifest.items) {
      if (typeof item.path !== "string" || !(item.path === "settings.yaml" || /^knowledge\/patterns\/[^/]+\.yaml$/.test(item.path))) throw new Error(`Invalid backup path: ${item.path}`);
      const from = resolve(root, item.path);
      if (!isWithin(root, await realpath(from))) throw new Error(`Backup item escapes source: ${item.path}`);
      const bytes = await readFile(from);
      if (hash(bytes) !== item.sha256) throw new Error(`Backup hash mismatch: ${item.path}`);
      const destination = resolve(dataRoot, item.path);
      let exists = false;
      try { if (hash(await readFile(destination)) !== item.sha256) throw new Error(`Restore conflict: ${destination}`); exists = true; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      pending.push({ destination, bytes, exists });
    }
    for (const item of pending) if (!item.exists) {
      await mkdir(dirname(item.destination), { recursive: true });
      const temporary = `${item.destination}.${process.pid}.tmp`;
      await writeFile(temporary, item.bytes, { flag: "wx" });
      await rename(temporary, item.destination);
    }
    await rebuildKnowledge({ dataRoot });
    return { schema_version: 2, imported_at: new Date().toISOString(), imported: pending.filter((item) => !item.exists).length, unchanged: pending.filter((item) => item.exists).length };
  } finally { await releaseOwnedLock(maintenance); }
}

async function copyYamlTree(source, destination, items, backupRoot) {
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".yaml")) await copyOptional(resolve(source, entry.name), resolve(destination, entry.name), items, backupRoot);
}

async function copyOptional(source, destination, items, backupRoot) {
  try { if (!(await stat(source)).isFile()) return; }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { errorOnExist: true, force: false });
  items.push({ path: relative(backupRoot, destination).replaceAll("\\", "/"), sha256: hash(await readFile(source)), source });
}

async function assertQuiescent(dataRoot) {
  const roots = [resolve(dataRoot, "state", "locks"), resolve(dataRoot, "knowledge")];
  for (const root of roots) {
    let names;
    try { names = await readdir(root); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const name of names.filter((name) => name.endsWith(".lock"))) {
      const path = resolve(root, name);
      const owner = JSON.parse(await readFile(path, "utf8"));
      let live = false;
      try { process.kill(owner.pid, 0); live = true; } catch (error) { live = error.code !== "ESRCH"; }
      if (live) throw new Error(`Backup requires idle writers: ${path}`);
    }
  }
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
