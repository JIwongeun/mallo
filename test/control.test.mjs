import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertSupportedServerRequest, buildResumeContext, consumeControl, publishControl, reconcileResumeState, validateServerResponse } from "../src/control.mjs";
import { writeYamlAtomic } from "../src/contracts.mjs";

test("control messages require current revision and exact pending request", async () => {
  const hub = await mkdtemp(join(tmpdir(), "codex-system-control-"));
  try {
    const runId = "run-22222222-2222-4222-8222-222222222222";
    const runRoot = resolve(hub, "run");
    await writeYamlAtomic(resolve(hub, ".local", "run-index", `${runId}.yaml`), { run_root: runRoot });
    await writeYamlAtomic(resolve(runRoot, "state.yaml"), { revision: 4, workflow_state: "needs_input", stage: "implementation", pending_request: { id: "7", method: "item/tool/requestUserInput" } });
    await assert.rejects(publishControl({ hubRoot: hub, runId, type: "cancel", expectedRevision: 3 }), /Stale/);
    await assert.rejects(publishControl({ hubRoot: hub, runId, type: "respond", requestId: "8", payload: { answers: {} } }), /does not match/);
    const message = await publishControl({ hubRoot: hub, runId, type: "respond", requestId: "7", payload: { answers: { choice: { answers: ["yes"] } } } });
    const accepted = await consumeControl({ hubRoot: hub, runId, currentRevision: 4 });
    assert.equal(accepted[0].operation_id, message.operation_id);
    assert.deepEqual(await consumeControl({ hubRoot: hub, runId, currentRevision: 4 }), []);
  } finally { await rm(hub, { recursive: true, force: true }); }
});

test("response validation and resume reconciliation fail closed", () => {
  assert.deepEqual(validateServerResponse("item/fileChange/requestApproval", { decision: "decline" }), { decision: "decline" });
  assert.throws(() => validateServerResponse("item/fileChange/requestApproval", { decision: "always" }), /invalid decision/);
  assert.throws(() => assertSupportedServerRequest("unknown/request"), /Unsupported pending request/);
  assert.deepEqual(reconcileResumeState({ workflow_state: "running", stage: "planning" }), { action: "restart_safe" });
  assert.match(reconcileResumeState({ workflow_state: "running", stage: "implementing" }).reason, /Refusing to replay/);
  assert.equal(reconcileResumeState({ workflow_state: "needs_input", stage: "planning", pending_questions: ["Choose one"] }).action, "needs_revision");
  assert.match(reconcileResumeState({ workflow_state: "needs_input", stage: "implementation", pending_request: { id: "7" } }).reason, /connection is gone/);
  assert.deepEqual(buildResumeContext({ workflow_state: "running", stage: "planning", revision: 7, route: "planned", repair_attempt: 1, replan_attempt: 1, completed_stages: ["triage"], criteria_revision: 2, request_revision: 3 }), {
    source_revision: 7, route: "planned", repair_attempt: 1, replan_attempt: 1, mutations_started: false, completed_stages: ["triage"], criteria_revision: 2, request_revision: 3,
  });
  assert.throws(() => buildResumeContext({ workflow_state: "running", stage: "implementation", mutations_started: true }), /Refusing to replay/);
});
