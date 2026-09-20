import test from "node:test";
import assert from "node:assert/strict";
import { checkSqlite, findExecutable } from "../src/doctor.mjs";
import { AppServerClient, defaultServerRequestResponse, evaluateRequiredModels } from "../src/codex.mjs";

test("SQLite FTS5 is available", () => {
  assert.deepEqual(checkSqlite().fts5, true);
});

test("missing executable returns null", async () => {
  assert.equal(await findExecutable("definitely-not-a-real-executable-codex-system"), null);
});

test("required model evaluation reports missing efforts", () => {
  const report = evaluateRequiredModels([
    { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "Sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
  ]);
  assert.equal(report["gpt-5.6-sol"].available, true);
  assert.deepEqual(report["gpt-5.6-sol"].missingEfforts, ["high", "xhigh"]);
  assert.equal(report["gpt-6-astra"].available, false);
});

test("protocol client decodes split-independent JSONL messages", async () => {
  const client = new AppServerClient({ codexPath: "unused" });
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 100);
    client.pending.set("7", { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject, timer, method: "probe" });
  });
  client.handleLine('{"id":7,"result":{"ok":true}}');
  assert.deepEqual(await response, { ok: true });
});

test("unknown response is surfaced as a protocol error", async () => {
  const client = new AppServerClient({ codexPath: "unused" });
  const error = new Promise((resolve) => client.once("protocolError", resolve));
  client.handleLine('{"id":999,"result":{}}');
  assert.match((await error).message, /unknown request/);
});

test("unhandled approval requests default to decline", () => {
  assert.deepEqual(defaultServerRequestResponse("item/commandExecution/requestApproval"), { decision: "decline" });
  assert.deepEqual(defaultServerRequestResponse("item/fileChange/requestApproval"), { decision: "decline" });
  assert.deepEqual(defaultServerRequestResponse("item/tool/requestUserInput"), { answers: {} });
  assert.throws(() => defaultServerRequestResponse("unknown/request"), /Unsupported server request/);
});
