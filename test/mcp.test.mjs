import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";

test("native bridge starts, observes, and answers one managed run", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-system-mcp-"));
  const home = join(root, "home");
  const hub = join(root, "hub");
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(hub, { recursive: true });
  const fakeCli = join(root, "fake-cli.mjs");
  const runId = "run-33333333-3333-4333-8333-333333333333";
  await writeFile(fakeCli, `
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const action = process.argv[2];
const done = resolve(process.cwd(), "done");
const finished = async () => { try { await access(done); return true; } catch { return false; } };
if (action === "run") {
  const request = JSON.parse(await readFile(process.argv[4], "utf8"));
  await writeFile(resolve(process.cwd(), "explicit-skills"), JSON.stringify(request.explicit_skills));
  await writeFile(resolve(process.cwd(), "controller-pid"), String(process.pid));
  process.stderr.write(JSON.stringify({ type: "progress", runId: "${runId}", workflowState: "running", stage: "triage", revision: 1 }) + "\\n");
  while (!(await finished())) await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  process.stdout.write(JSON.stringify({ runId: "${runId}", outcome: { status: "completed" } }));
} else if (action === "status") {
  const complete = await finished();
  let alive = true;
  try { process.kill(Number(await readFile(resolve(process.cwd(), "controller-pid"), "utf8")), 0); } catch { alive = false; }
  process.stdout.write(JSON.stringify({ state: complete ? { workflow_state: "completed" } : !alive ? { workflow_state: "failed" } : { workflow_state: "needs_input", pending_request: { id: "7", method: "item/tool/requestUserInput" } }, outcome: complete ? { status: "completed" } : null }));
} else if (action === "respond" || action === "cancel") {
  await writeFile(done, action);
  process.stdout.write(JSON.stringify({ accepted: true }));
}
`);
  await writeFile(join(home, ".codex", "codex-system.json"), `${JSON.stringify({ schema_version: 1, hub_root: hub, node_path: process.execPath, cli_path: fakeCli })}\n`);
  const child = spawn(process.execPath, [resolve("plugins/codex-system/server.mjs")], { env: { ...process.env, CODEX_HOME: join(home, ".codex") }, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => { const value = JSON.parse(line); replies.set(value.id, value); });
  const request = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for (let attempt = 0; attempt < 400 && !replies.has(id); attempt += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    if (!replies.has(id)) throw new Error(`MCP bridge did not answer request ${id}`);
    return replies.get(id).result;
  };
  try {
    const initialized = await request(1, "initialize", { protocolVersion: "2024-11-05" });
    assert.deepEqual(initialized.serverInfo, { name: "mallo", title: "Mallo", version: "0.2.2" });
    const listed = await request(2, "tools/list", {});
    assert.deepEqual(listed.tools.map(({ name, title, annotations }) => [name, title, annotations.title]), [
      ["start_managed_task", "Start Mallo task", "Start Mallo task"],
      ["await_managed_task", "Check Mallo progress", "Check Mallo progress"],
      ["respond_managed_task", "Send answer to Mallo", "Send answer to Mallo"],
      ["cancel_managed_task", "Cancel Mallo task", "Cancel Mallo task"],
    ]);
    assert.match(listed.tools[0].description, /Mallo/);
    const started = parseText(await request(3, "tools/call", { name: "start_managed_task", arguments: { request: "Test", original_request: "$review-agent Test", cwd: hub, explicit_skills: ["review-agent"] } }));
    assert.equal(started.run_id, runId);
    assert.equal(await readFile(join(hub, "explicit-skills"), "utf8"), '["review-agent"]');
    // The startup deadline must be cleared after admission, not kill a live run at 15 seconds.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_200));
    const waiting = parseText(await request(4, "tools/call", { name: "await_managed_task", arguments: { run_id: runId, timeout_ms: 0, after_revision: 0 } }));
    assert.equal(waiting.state.workflow_state, "needs_input");
    const responded = parseText(await request(5, "tools/call", { name: "respond_managed_task", arguments: { run_id: runId, request_id: "7", payload: { answers: { choice: { answers: ["yes"] } } } } }));
    assert.equal(responded.accepted, true);
    const completed = parseText(await request(6, "tools/call", { name: "await_managed_task", arguments: { run_id: runId, timeout_ms: 1_000 } }));
    assert.equal(completed.outcome.status, "completed");
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "close");
    await rm(root, { recursive: true, force: true });
  }
});

function parseText(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}
