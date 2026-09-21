import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const ROOT = "019d2000-0000-7000-8000-000000000001";
const TURN = "019d2000-0000-7000-8000-000000000002";
const serverPath = resolve("plugins/codex-system/server.mjs");
const cliPath = resolve("plugins/codex-system/cli.mjs");

test("native MCP hooks pass identifiers only and contain no control output", async () => {
  const config = JSON.parse(await readFile(resolve("plugins/codex-system/hooks/hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(config.hooks), ["UserPromptSubmit", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "Interrupt"]);
  const serialized = JSON.stringify(config);
  for (const forbidden of ["prompt", "tool_input", "tool_response", "last_assistant_message", "additionalContext", "decision", "continue"]) assert(!serialized.includes(forbidden));
  for (const groups of Object.values(config.hooks)) for (const group of groups) for (const hook of group.hooks) {
    assert.equal(hook.type, "mcp_tool");
    assert.equal(hook.server, "mallo");
    assert.equal(hook.tool, "observe_activity");
  }
});

test("declared MCP config starts in a relocated plugin root without Codex on PATH", async (t) => {
  const config = JSON.parse(await readFile(resolve("plugins/codex-system/.mcp.json"), "utf8"));
  const declared = config.mcpServers.mallo;
  assert.equal(declared.command, "node");
  assert.deepEqual(declared.args, ["server.mjs"]);
  assert.equal(declared.cwd, ".");

  const root = await mkdtemp(join(tmpdir(), "mallo-native-cwd-"));
  const plugin = join(root, "relocated plugin");
  const bin = join(root, "bin");
  await Promise.all([mkdir(join(plugin, "lib"), { recursive: true }), mkdir(bin, { recursive: true })]);
  await Promise.all([
    copyFile(serverPath, join(plugin, "server.mjs")),
    copyFile(resolve("plugins/codex-system/lib/activity.mjs"), join(plugin, "lib", "activity.mjs")),
    copyFile(resolve("plugins/codex-system/lib/observe.mjs"), join(plugin, "lib", "observe.mjs")),
  ]);
  const node = join(bin, process.platform === "win32" ? "node.exe" : "node");
  try { await link(process.execPath, node); }
  catch { await copyFile(process.execPath, node); await chmod(node, 0o755); }
  const env = { ...process.env, PATH: bin, MALLO_TRANSCRIPT_ROOTS: await fixture() };
  assert(spawnSync("codex", ["--version"], { cwd: root, env }).error);

  const child = spawn(declared.command, declared.args, { cwd: resolve(plugin, declared.cwd), env, stdio: ["pipe", "pipe", "pipe"] });
  const client = jsonRpcClient(child);
  t.after(() => client.close());
  const initialized = await client.call("initialize", { protocolVersion: "2026-01-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.serverInfo.name, "mallo");
});

test("MCP exposes only read-only activity tools", async (t) => {
  const transcriptRoot = await fixture();
  const client = startClient(transcriptRoot);
  t.after(() => client.close());
  const initialized = await client.call("initialize", { protocolVersion: "2026-01-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.serverInfo.version, "0.3.1");
  const listed = await client.call("tools/list", {});
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["show_activity", "list_activity", "observe_activity"]);
  assert(listed.tools.every((tool) => tool.annotations.readOnlyHint === true));
  const sessions = await client.call("tools/call", { name: "list_activity", arguments: {} });
  assert.equal(sessions.structuredContent.sessions[0].session_id, ROOT);
  const shown = await client.call("tools/call", { name: "show_activity", arguments: { session_id: ROOT } });
  assert.equal(shown.structuredContent.current.model.value, "gpt-5.6-sol");
  assert.equal(shown.structuredContent.session.state, "native_turn_completed");
  assert(shown.content[0].text.includes("Native state"));
  const compact = await client.call("tools/call", { name: "show_activity", arguments: { session_id: ROOT, view: "current", phase: "summary", turn_id: TURN } });
  assert(!("structuredContent" in compact));
  assert.match(compact.content[0].text, /^Mallo 작업요약/m);
  assert(!compact.content[0].text.includes("> **"));
  assert(!compact.content[0].text.includes("|---|"));
  for (const privateValue of ["SECRET_PROMPT", "SECRET_ARGUMENT", "SECRET_RESULT", transcriptRoot]) assert(!JSON.stringify(compact).includes(privateValue));
  const cliJson = spawnSync(process.execPath, [cliPath, "status", "--session", ROOT, "--view", "current", "--phase", "summary", "--turn", TURN, "--json"], { encoding: "utf8", env: { ...process.env, MALLO_TRANSCRIPT_ROOTS: transcriptRoot } });
  assert.equal(cliJson.status, 0, cliJson.stderr);
  const snapshot = JSON.parse(cliJson.stdout);
  assert.equal(compact.content[0].text, snapshot.text);
  const cliCompact = spawnSync(process.execPath, [cliPath, "status", "--session", ROOT, "--view", "current", "--phase", "summary", "--turn", TURN], { encoding: "utf8", env: { ...process.env, MALLO_TRANSCRIPT_ROOTS: transcriptRoot } });
  assert.equal(cliCompact.status, 0, cliCompact.stderr);
  assert.equal(cliCompact.stdout.trim(), snapshot.line);
  const cliMarkdown = spawnSync(process.execPath, [cliPath, "status", "--session", ROOT, "--view", "current", "--phase", "summary", "--turn", TURN, "--format", "markdown"], { encoding: "utf8", env: { ...process.env, MALLO_TRANSCRIPT_ROOTS: transcriptRoot } });
  assert.equal(cliMarkdown.status, 0, cliMarkdown.stderr);
  assert.equal(cliMarkdown.stdout.trim(), snapshot.markdown);
  assert.match(snapshot.markdown, /^> \*\*Mallo 작업요약\*\*/);
  assert(snapshot.markdown.split("\n").every((line) => line.startsWith(">")));
  const malformed = await client.call("tools/call", { name: "show_activity", arguments: { session_id: "latest" } });
  assert.equal(malformed.isError, true);
  const missingPhase = await client.call("tools/call", { name: "show_activity", arguments: { session_id: ROOT, view: "current" } });
  assert.equal(missingPhase.isError, true);
  const strayPhase = await client.call("tools/call", { name: "show_activity", arguments: { session_id: ROOT, phase: "progress" } });
  assert.equal(strayPhase.isError, true);
  const invalidTurn = await client.call("tools/call", { name: "show_activity", arguments: { session_id: ROOT, view: "current", phase: "progress", turn_id: "latest" } });
  assert.equal(invalidTurn.isError, true);
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => client.call("tools/call", { name: "show_activity", arguments: { session_id: ROOT } })));
  assert(concurrent.every((result) => result.structuredContent.history.length === 1));
  const observed = await client.call("tools/call", { name: "observe_activity", arguments: { session_id: ROOT, turn_id: TURN, hook_event_name: "Stop", model: "ignored-secret-free" } });
  assert.deepEqual(Object.keys(JSON.parse(observed.content[0].text)), ["systemMessage"]);
  assert(!observed.content[0].text.includes("additionalContext"));
  assert(!observed.content[0].text.includes("decision"));
  const duplicate = await client.call("tools/call", { name: "observe_activity", arguments: { session_id: ROOT, turn_id: TURN, hook_event_name: "Stop", model: "ignored-secret-free" } });
  assert.deepEqual(JSON.parse(duplicate.content[0].text), {});
  const repeatedCompact = await client.call("tools/call", { name: "show_activity", arguments: { session_id: ROOT, view: "current", phase: "summary", turn_id: TURN } });
  assert.equal(repeatedCompact.content[0].text, compact.content[0].text);
});

test("CLI requires an explicit status session and reads isolated roots", async () => {
  const transcriptRoot = await fixture();
  const env = { ...process.env, MALLO_TRANSCRIPT_ROOTS: transcriptRoot };
  const missing = spawnSync(process.execPath, [cliPath, "status"], { encoding: "utf8", env });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--session is required/);
  const result = spawnSync(process.execPath, [cliPath, "status", "--session", ROOT, "--json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).session.id, ROOT);
  const compact = spawnSync(process.execPath, [cliPath, "status", "--session", ROOT, "--view", "current", "--phase", "progress", "--json"], { encoding: "utf8", env });
  assert.equal(compact.status, 0, compact.stderr);
  assert.deepEqual(Object.keys(JSON.parse(compact.stdout)), ["schema_version", "thread_id", "turn_id", "native_state", "coverage", "steps", "line", "text", "markdown"]);
  assert.deepEqual(JSON.parse(compact.stdout).steps.map((step) => step.task), ["대화 작업"]);
  for (const args of [
    ["status", "--session", ROOT, "--view", "current"],
    ["status", "--session", ROOT, "--view", "current", "--phase", "later"],
    ["status", "--session", ROOT, "--view", "current", "--phase", "progress", "--format", "html"],
    ["status", "--session", ROOT, "--view", "current", "--phase", "progress", "--format"],
    ["status", "--session", ROOT, "--bogus", "value"],
    ["status", "--session", ROOT, "--phase", "progress"],
  ]) {
    const invalid = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env });
    assert.notEqual(invalid.status, 0, args.join(" "));
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mallo-transport-"));
  const records = [
    { timestamp: "2026-09-20T00:00:00Z", type: "session_meta", payload: { id: ROOT, session_id: ROOT, timestamp: "2026-09-20T00:00:00Z" } },
    { timestamp: "2026-09-20T00:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: TURN, started_at: "2026-09-20T00:00:01Z" } },
    { timestamp: "2026-09-20T00:00:02Z", type: "turn_context", payload: { turn_id: TURN, model: "gpt-5.6-sol", effort: "high" } },
    { timestamp: "2026-09-20T00:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "SECRET_PROMPT" }] } },
    { timestamp: "2026-09-20T00:00:02Z", type: "response_item", payload: { type: "function_call", name: "functions.exec_command", call_id: "private-call", arguments: JSON.stringify({ cmd: "Write-Output SECRET_ARGUMENT" }) } },
    { timestamp: "2026-09-20T00:00:02Z", type: "response_item", payload: { type: "function_call_output", call_id: "private-call", output: JSON.stringify({ exit_code: 0, output: "SECRET_RESULT" }) } },
    { timestamp: "2026-09-20T00:00:03Z", type: "event_msg", payload: { type: "task_complete", turn_id: TURN, completed_at: "2026-09-20T00:00:03Z", duration_ms: 2000 } },
  ];
  await writeFile(join(root, `rollout-${ROOT}.jsonl`), `${records.map(JSON.stringify).join("\n")}\n`);
  return root;
}

function startClient(transcriptRoot) {
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, MALLO_TRANSCRIPT_ROOTS: transcriptRoot }, stdio: ["pipe", "pipe", "pipe"] });
  return jsonRpcClient(child);
}

function jsonRpcClient(child) {
  const pending = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  return {
    call(method, params) {
      const requestId = ++id;
      const promise = new Promise((resolvePromise, rejectPromise) => pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      return promise;
    },
    close() { child.stdin.end(); child.kill(); },
  };
}
