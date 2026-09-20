import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

const MAX_REQUEST = 100_000;
const MAX_OUTPUT = 1_000_000;
const activeByCall = new Map();
const activeByRun = new Map();
let pinnedPointer;

const requestProperties = {
  request: { type: "string", minLength: 1, maxLength: MAX_REQUEST },
  original_request: { type: "string", minLength: 1, maxLength: MAX_REQUEST },
  cwd: { type: "string", minLength: 1 },
  session_id: { type: "string" },
  explicit_skills: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 10 },
};

const tools = [
  {
    name: "start_managed_task",
    description: "Start one current-folder request through Mallo and return its run ID. Use the exact user message, normalized project task, and current cwd.",
    inputSchema: { type: "object", properties: requestProperties, required: ["request", "original_request", "cwd"], additionalProperties: false },
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "await_managed_task",
    description: "Wait briefly for a managed run, then return its durable state and outcome. Repeat until terminal or needs_input.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, timeout_ms: { type: "integer", minimum: 0, maximum: 30_000 }, after_revision: { type: "integer", minimum: 0 } }, required: ["run_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "respond_managed_task",
    description: "Deliver the user's actual answer or approval to the exact pending request of a managed run.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, request_id: { type: "string" }, payload: { type: "object" } }, required: ["run_id", "request_id", "payload"], additionalProperties: false },
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: "cancel_managed_task",
    description: "Request cancellation of an active managed run.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"], additionalProperties: false },
    annotations: { destructiveHint: false, openWorldHint: false },
  },
];

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch { return sendError(null, -32700, "Parse error"); }
  void handle(message);
});
lines.on("close", () => {
  for (const run of activeByRun.values()) stopChild(run.child);
  for (const child of activeByCall.values()) stopChild(child);
});

async function handle(message) {
  if (message.method === "notifications/cancelled") {
    stopChild(activeByCall.get(String(message.params?.requestId)));
    return;
  }
  if (!("id" in message)) return;
  try {
    if (message.method === "initialize") return send(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "codex-system", version: "0.2.1" },
    });
    if (message.method === "ping") return send(message.id, {});
    if (message.method === "tools/list") return send(message.id, { tools });
    if (message.method === "tools/call") return send(message.id, await callTool(message.id, message.params));
    return sendError(message.id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    send(message.id, { content: [{ type: "text", text: error.message }], isError: true });
  }
}

async function callTool(callId, params) {
  const input = params?.arguments ?? {};
  if (params?.name === "start_managed_task") return textResult(await startTask(callId, input));
  if (params?.name === "await_managed_task") return textResult(await awaitTask(input));
  if (params?.name === "respond_managed_task") return textResult(await controlTask("respond", input));
  if (params?.name === "cancel_managed_task") return textResult(await controlTask("cancel", input));
  throw new Error(`Unknown tool: ${params?.name}`);
}

async function startTask(callId, input) {
  validateStart(input);
  const pointer = await readPointer();
  const requestPath = resolve(pointer.data_root, "state", "mcp-requests", `${randomUUID()}.json`);
  await mkdir(dirname(requestPath), { recursive: true });
  await writeFile(requestPath, `${JSON.stringify({ schema_version: 1, request: input.request, original_request: input.original_request, cwd: resolve(input.cwd), explicit_skills: input.explicit_skills ?? [], client: { kind: "codex-skill", session_id: input.session_id ?? null } }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const run = spawnRunner(pointer, ["run", "--request-file", requestPath], callId, requestPath);
  let timer;
  let runId;
  try {
    runId = await Promise.race([run.started, new Promise((_, reject) => {
      timer = setTimeout(() => { stopChild(run.child); reject(new Error("Runner did not publish a run ID within 15 seconds")); }, 15_000);
    })]);
  } finally { clearTimeout(timer); activeByCall.delete(String(callId)); }
  if (!run.done) activeByRun.set(runId, run);
  return { run_id: runId, status: "running", progress: run.progress.slice(-20) };
}

async function awaitTask(input) {
  assertRunId(input.run_id);
  const timeoutMs = Number.isInteger(input.timeout_ms) ? input.timeout_ms : 30_000;
  if (timeoutMs < 0 || timeoutMs > 30_000) throw new Error("timeout_ms must be between 0 and 30000");
  const run = activeByRun.get(input.run_id);
  if (run && !run.done && timeoutMs > 0) await Promise.race([run.finished, delay(timeoutMs)]);
  const status = await runCli(["status", "--run-id", input.run_id, "--after-sequence", String(input.after_revision ?? 0)]);
  const afterRevision = Number.isInteger(input.after_revision) ? input.after_revision : 0;
  const progress = status.events ?? run?.progress.filter((event) => !Number.isInteger(event.revision) || event.revision > afterRevision).slice(-20) ?? [];
  return { ...status, progress, next_revision: status.state?.revision ?? afterRevision };
}

async function controlTask(type, input) {
  assertRunId(input.run_id);
  if (type === "cancel") return runCli(["cancel", "--run-id", input.run_id]);
  if (typeof input.request_id !== "string" || !input.request_id) throw new Error("request_id is required");
  const pointer = await readPointer();
  const responsePath = resolve(pointer.data_root, "state", "mcp-responses", `${randomUUID()}.json`);
  await mkdir(dirname(responsePath), { recursive: true });
  await writeFile(responsePath, `${JSON.stringify(input.payload)}\n`, { encoding: "utf8", flag: "wx" });
  try { return await runCli(["respond", "--run-id", input.run_id, "--request-id", input.request_id, "--file", responsePath]); }
  finally { await rm(responsePath, { force: true }); }
}

function spawnRunner(pointer, cliArgs, callId, requestPath) {
  const child = spawn(pointer.node_path, [pointer.cli_path, ...cliArgs], { cwd: pointer.runtime_root, env: { ...process.env, CODEX_SYSTEM_DATA_ROOT: pointer.data_root }, shell: false, windowsHide: true });
  activeByCall.set(String(callId), child);
  const run = { child, stdout: "", stderr: "", lineBuffer: "", progress: [], done: false };
  let resolveStarted;
  let rejectStarted;
  run.started = new Promise((resolvePromise, rejectPromise) => { resolveStarted = resolvePromise; rejectStarted = rejectPromise; });
  run.finished = new Promise((resolvePromise) => {
    child.stdout.on("data", (chunk) => { run.stdout = `${run.stdout}${chunk}`.slice(-MAX_OUTPUT); });
    child.stderr.on("data", (chunk) => {
      run.stderr = `${run.stderr}${chunk}`.slice(-MAX_OUTPUT);
      run.lineBuffer += chunk;
      const parts = run.lineBuffer.split(/\r?\n/);
      run.lineBuffer = parts.pop() ?? "";
      for (const line of parts.filter(Boolean)) {
        let event;
        try { event = JSON.parse(line); }
        catch { event = { type: "message", message: line.slice(-4000) }; }
        run.progress.push(event);
        if (run.progress.length > 100) run.progress.shift();
        if (event.runId) resolveStarted(event.runId);
      }
    });
    child.on("error", (error) => { rejectStarted(error); resolvePromise(); });
    child.on("close", (code, signal) => {
      run.done = true;
      run.code = code;
      run.signal = signal;
      activeByCall.delete(String(callId));
      for (const [runId, value] of activeByRun) if (value === run) activeByRun.delete(runId);
      if (!run.progress.some((event) => event.runId)) rejectStarted(new Error(`Runner exited before a run started: ${(run.stderr || run.stdout).slice(-4000)}`));
      void rm(requestPath, { force: true });
      resolvePromise();
    });
  });
  return run;
}

async function runCli(args) {
  const pointer = await readPointer();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pointer.node_path, [pointer.cli_path, ...args], { cwd: pointer.runtime_root, env: { ...process.env, CODEX_SYSTEM_DATA_ROOT: pointer.data_root }, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { stopChild(child); rejectPromise(new Error("Control command timed out")); }, 15_000);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT); });
    child.on("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return rejectPromise(new Error(`Command stopped by ${signal}`));
      try { resolvePromise({ ...JSON.parse(stdout), exit_code: code }); }
      catch { rejectPromise(new Error(`Command returned invalid JSON: ${(stderr || stdout).slice(-4000)}`)); }
    });
  });
}

async function readPointer() {
  if (pinnedPointer) return pinnedPointer;
  const pointerPath = resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"), "codex-system.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  const normalized = { ...pointer, runtime_root: pointer.runtime_root ?? pointer.hub_root, data_root: pointer.data_root ?? pointer.hub_root, release_id: pointer.release_id ?? "legacy-0.1.1" };
  if (![1, 2].includes(normalized.schema_version) || !isAbsolute(normalized.runtime_root) || !isAbsolute(normalized.data_root) || !isAbsolute(normalized.node_path) || !isAbsolute(normalized.cli_path) || typeof normalized.release_id !== "string") throw new Error("Invalid Mallo pointer");
  await Promise.all([access(normalized.node_path), access(normalized.cli_path), access(normalized.runtime_root), access(normalized.data_root)]);
  pinnedPointer = normalized;
  return normalized;
}

function validateStart(input) {
  if (typeof input.request !== "string" || !input.request.trim() || input.request.length > MAX_REQUEST) throw new Error("request must be a non-empty bounded string");
  if (typeof input.original_request !== "string" || !input.original_request.trim() || input.original_request.length > MAX_REQUEST) throw new Error("original_request must be the exact bounded user message");
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) throw new Error("cwd must be an absolute path");
  if (input.explicit_skills !== undefined && (!Array.isArray(input.explicit_skills) || input.explicit_skills.length > 10 || input.explicit_skills.some((id) => typeof id !== "string" || !id))) throw new Error("explicit_skills must be bounded string identifiers");
}

function assertRunId(runId) {
  if (!/^run-[0-9a-f-]+$/i.test(runId ?? "")) throw new Error(`Invalid run ID: ${runId}`);
}

function textResult(value) { return { content: [{ type: "text", text: JSON.stringify(value) }] }; }
function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000, stdio: "ignore" });
  else child.kill();
}
function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function send(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function sendError(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`); }
