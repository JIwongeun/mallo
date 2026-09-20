import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function acquireOwnedLock(path, details = {}, busyMessage = `Lock is busy: ${path}`) {
  await mkdir(dirname(path), { recursive: true });
  try { return await createLock(path, details); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let original;
  try {
    const raw = await readFile(path, "utf8");
    original = { raw, owner: JSON.parse(raw) };
  } catch (error) {
    if (error.code === "ENOENT") return acquireOwnedLock(path, details, busyMessage);
    throw new Error(busyMessage);
  }
  if (isProcessAlive(original.owner.pid)) throw new Error(busyMessage);
  const quarantine = `${path}.stale-${randomUUID()}`;
  try { await rename(path, quarantine); }
  catch (error) {
    if (error.code === "ENOENT") return acquireOwnedLock(path, details, busyMessage);
    throw error;
  }
  let lock;
  try { lock = await createLock(path, { ...details, recovered_from: original.owner.nonce ?? null }); }
  catch (error) {
    await unlink(quarantine).catch(() => {});
    if (error.code === "EEXIST") throw new Error(busyMessage);
    throw error;
  }
  const moved = await readFile(quarantine, "utf8");
  if (moved !== original.raw) {
    await writeFile(path, moved, "utf8");
    await unlink(quarantine);
    throw new Error(busyMessage);
  }
  await unlink(quarantine);
  return lock;
}

export async function releaseOwnedLock(lock) {
  try {
    const current = JSON.parse(await readFile(lock.path, "utf8"));
    if (current.nonce !== lock.nonce) throw new Error(`Lock ownership changed: ${lock.path}`);
    await unlink(lock.path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function assertMaintenanceInactive(hubRoot) {
  for (const path of [resolve(hubRoot, "state", "maintenance.lock"), resolve(hubRoot, ".local", "maintenance.lock")]) {
    try {
      await access(path);
      throw new Error(`Relay maintenance is active: ${path}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function createLock(path, details) {
  const nonce = randomUUID();
  let handle;
  try {
    handle = await open(path, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, created_at: new Date().toISOString(), ...details }));
    await handle.close();
    return { path, nonce };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
    }
    throw error;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}
