import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readYaml } from "./contracts.mjs";

const TERMINAL = new Set(["completed", "failed", "blocked", "cancelled"]);
const SUPPORTED_SERVER_REQUESTS = new Set([
  "item/tool/requestUserInput",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

export async function readRunState(hubRoot, runId) {
  assertRunId(runId);
  const index = await readYaml(resolve(hubRoot, ".local", "run-index", `${runId}.yaml`));
  const state = await readYaml(resolve(index.run_root, "state.yaml"));
  return { index, state };
}

export async function publishControl({ hubRoot, runId, type, expectedRevision = null, requestId = null, payload = null }) {
  if (!["cancel", "respond"].includes(type)) throw new Error(`Unsupported control type: ${type}`);
  const { state } = await readRunState(hubRoot, runId);
  if (TERMINAL.has(state.workflow_state)) throw new Error(`Run is already terminal: ${state.workflow_state}`);
  const revision = expectedRevision ?? state.revision;
  if (revision !== state.revision) throw new Error(`Stale control revision: expected ${revision}, current ${state.revision}`);
  if (type === "respond") {
    if (!requestId || state.pending_request?.id !== requestId) throw new Error(`Response does not match the pending request: ${requestId}`);
    validateServerResponse(state.pending_request.method, payload);
  }
  const message = { schema_version: 1, operation_id: randomUUID(), run_id: runId, type, expected_revision: revision, request_id: requestId, payload, created_at: new Date().toISOString() };
  await writeJsonAtomic(resolve(hubRoot, ".local", "control", runId, `${message.operation_id}.json`), message);
  return message;
}

export async function consumeControl({ hubRoot, runId, currentRevision }) {
  const root = resolve(hubRoot, ".local", "control", runId);
  let names;
  try { names = (await readdir(root)).filter((name) => name.endsWith(".json") && !name.endsWith(".ack.json")).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const accepted = [];
  for (const name of names) {
    const path = resolve(root, name);
    const message = JSON.parse(await readFile(path, "utf8"));
    const ackPath = `${path.slice(0, -5)}.ack.json`;
    try { await readFile(ackPath); await rename(path, `${path}.consumed`); continue; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (message.schema_version !== 1 || !["cancel", "respond"].includes(message.type) || typeof message.operation_id !== "string" || !Number.isInteger(message.expected_revision)) throw new Error("Invalid control message");
    const matchesRevision = message.expected_revision === currentRevision || (message.type === "cancel" && message.expected_revision < currentRevision);
    const ack = message.run_id === runId && matchesRevision
      ? { status: "accepted", current_revision: currentRevision }
      : { status: "rejected_stale", current_revision: currentRevision };
    if (ack.status === "accepted") accepted.push(message);
    await writeJsonAtomic(ackPath, { schema_version: 1, operation_id: message.operation_id, ...ack, acknowledged_at: new Date().toISOString() });
    await rename(path, `${path}.consumed`);
  }
  return accepted;
}

export function validateServerResponse(method, payload) {
  if (!SUPPORTED_SERVER_REQUESTS.has(method)) throw new Error(`Unsupported pending request: ${method}`);
  if (method === "item/tool/requestUserInput") {
    if (!payload?.answers || typeof payload.answers !== "object") throw new Error("User-input response requires answers");
    for (const answer of Object.values(payload.answers)) if (!Array.isArray(answer?.answers) || answer.answers.some((item) => typeof item !== "string")) throw new Error("Each user-input answer must contain string answers");
    return payload;
  }
  if (method === "item/permissions/requestApproval") {
    if (!payload?.permissions || typeof payload.permissions !== "object" || Array.isArray(payload.permissions) || !["turn", "session"].includes(payload.scope)) throw new Error("Permission response requires permissions and scope");
    for (const key of Object.keys(payload.permissions)) if (!["network", "fileSystem"].includes(key)) throw new Error(`Unknown permission: ${key}`);
    return payload;
  }
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) {
    if (!["accept", "acceptForSession", "decline", "cancel"].includes(payload?.decision)) throw new Error("Approval response has an invalid decision");
    return payload;
  }
  return payload;
}

export function assertSupportedServerRequest(method) {
  if (!SUPPORTED_SERVER_REQUESTS.has(method)) throw new Error(`Unsupported pending request: ${method}`);
}

export function reconcileResumeState(state) {
  if (TERMINAL.has(state.workflow_state)) return { action: "terminal" };
  if (state.pending_request) return { action: "blocked", reason: "The native request connection is gone; start a revised request instead of replaying an approval or answer" };
  if (state.pending_questions?.length && !state.mutations_started) return { action: "needs_revision", reason: "Planning questions require a revised request containing the user's answers" };
  if (["triage", "planning", "plan-review"].includes(state.stage) && !state.mutations_started) return { action: "restart_safe" };
  return { action: "blocked", reason: `Refusing to replay possibly mutating stage: ${state.stage}` };
}

export function buildResumeContext(state) {
  const reconciliation = reconcileResumeState(state);
  if (!["restart_safe", "needs_revision"].includes(reconciliation.action)) throw new Error(reconciliation.reason ?? `Run cannot resume from ${state.workflow_state}`);
  return {
    source_revision: state.revision,
    route: state.route ?? null,
    repair_attempt: state.repair_attempt ?? 0,
    replan_attempt: state.replan_attempt ?? 0,
    mutations_started: Boolean(state.mutations_started),
    completed_stages: state.completed_stages ?? [],
    criteria_revision: state.criteria_revision ?? 1,
    request_revision: state.request_revision ?? 1,
  };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

function assertRunId(runId) {
  if (!/^run-[0-9a-f-]+$/i.test(runId ?? "")) throw new Error(`Invalid run ID: ${runId}`);
}
