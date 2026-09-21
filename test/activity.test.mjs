import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatStatus, formatStatusLine, getStatus, listSessions } from "../plugins/codex-system/lib/activity.mjs";
import { currentActivity } from "../plugins/codex-system/lib/observe.mjs";

const ROOT = "019d0000-0000-7000-8000-000000000001";
const CHILD = "019d0000-0000-7000-8000-000000000002";
const OTHER = "019d0000-0000-7000-8000-000000000003";
const TURN_OLD = "019d1000-0000-7000-8000-000000000001";
const TURN_DONE = "019d1000-0000-7000-8000-000000000002";
const TURN_ACTIVE = "019d1000-0000-7000-8000-000000000003";
const CHILD_TURN = "019d1000-0000-7000-8000-000000000004";
const TOP_PATH_CHILD = "019d0000-0000-7000-8000-000000000008";
const INVALID_PATH_CHILD = "019d0000-0000-7000-8000-000000000009";

test("reads native parent/worker activity without retaining raw content", async () => {
  const root = await fixtureRoot();
  await writeJsonl(join(root, `rollout-${ROOT}.jsonl`), [
    sessionMeta(ROOT, ROOT),
    event("task_started", TURN_OLD, "2026-09-20T00:00:00Z"),
    context(TURN_OLD, "gpt-5.6-sol", "high"),
    event("task_started", TURN_DONE, "2026-09-20T00:01:00Z"),
    context(TURN_DONE, "gpt-5.6-sol", "high"),
    response({ type: "message", role: "user", content: [{ type: "input_text", text: "SECRET_PROMPT" }] }),
    response({ type: "function_call", name: "functions.exec_command", call_id: "call-read", arguments: JSON.stringify({ cmd: "Get-Content C:\\skills\\router\\SKILL.md" }) }),
    response({ type: "function_call_output", call_id: "call-read", output: JSON.stringify({ exit_code: 0, output: "SECRET_RESULT" }) }),
    response({ type: "function_call", name: "collaboration.spawn_agent", call_id: "call-spawn", arguments: JSON.stringify({ task_name: "review", model: "gpt-6-astra", reasoning_effort: "high", message: "SECRET_WORK" }) }),
    response({ type: "function_call_output", call_id: "call-spawn", output: JSON.stringify({ task_name: "review" }) }),
    event("task_complete", TURN_DONE, "2026-09-20T00:02:00Z"),
    event("task_started", TURN_ACTIVE, "2026-09-20T00:03:00Z"),
    context(TURN_ACTIVE, "gpt-5.6-sol", "high"),
    response({ type: "custom_tool_call", name: "functions.exec", call_id: "call-patch", status: "completed", input: "const patch = 'Get-Content C:/skills/native-read/SKILL.md'; await tools.apply_patch(patch)" }),
    response({ type: "custom_tool_call", name: "functions.exec", call_id: "call-current", status: "in_progress", input: "await tools.exec_command({cmd:'Get-Content C:/skills/real-skill/SKILL.md; Set-Content C:/skills/write-only/SKILL.md -Value bad'}); await tools.exec_command({\"cmd\":\"Get-Content C:/skills/second-skill/SKILL.md\"}); await tools.exec_command({cmd:'Get-Content C:/skills/mallo/SKILL.md; Get-Content C:/skills/Codex-System:Mallo/SKILL.md; Get-Content C:/skills/mallo-helper/SKILL.md'})" }),
  ], "{partial");
  await writeJsonl(join(root, `rollout-${CHILD}.jsonl`), [
    sessionMeta(CHILD, ROOT, { source: { subagent: { thread_spawn: { parent_thread_id: ROOT, agent_nickname: "reviewer", agent_path: "/root/compact_presentation" } } } }),
    event("task_started", CHILD_TURN, "2026-09-20T00:01:10Z"),
    context(CHILD_TURN, "gpt-6-astra", "high"),
    response({ type: "custom_tool_call", name: "functions.exec", call_id: "child-call", status: "completed", input: "await tools.exec_command({cmd:'exit 1'})" }),
    response({ type: "custom_tool_call_output", call_id: "child-call", output: [{ exit_code: 1 }] }),
    response({ type: "future_unknown", arbitrary: "SECRET_UNKNOWN" }),
    event("task_complete", CHILD_TURN, "2026-09-20T00:02:10Z"),
  ]);
  await writeJsonl(join(root, `rollout-${OTHER}.jsonl`), [sessionMeta(OTHER, OTHER), event("task_started", "019d1000-0000-7000-8000-000000000009", "2026-09-20T00:00:00Z")]);

  const status = await getStatus(ROOT, { transcriptRoots: [root], now: () => Date.parse("2026-09-20T00:04:00Z") });
  assert.equal(status.session.id, ROOT);
  assert.equal(status.session.state, "active");
  assert.equal(status.agents.length, 2);
  assert.deepEqual(status.agents.map((agent) => [agent.role, agent.turns.at(-1).model.value, agent.turns.at(-1).effort.value]), [
    ["main", "gpt-5.6-sol", "high"], ["worker", "gpt-6-astra", "high"],
  ]);
  assert.equal(status.agents[0].turns[0].state, "interrupted_or_unknown");
  assert.equal(status.agents[1].task_label, "compact_presentation");
  assert.equal(status.current.current_tool.name, "functions.exec");
  assert.deepEqual(status.agents[0].turns.at(-1).skills.items.map((item) => item.name), ["real-skill", "second-skill", "mallo", "Codex-System:Mallo", "mallo-helper"]);
  assert(!serializedSkillNames(status).includes("native-read"));
  assert(!serializedSkillNames(status).includes("write-only"));
  assert.equal(status.agents[1].turns[0].tool_summary.failed, 1);
  assert.deepEqual(status.requested_workers.map((item) => [item.requested_model, item.requested_effort]), [["gpt-6-astra", "high"]]);
  assert.equal(status.coverage.state, "partial");
  assert(status.coverage.warnings.some((warning) => warning.code === "partial_tail"));
  const serialized = JSON.stringify(status);
  for (const secret of ["SECRET_PROMPT", "SECRET_RESULT", "SECRET_WORK", "SECRET_UNKNOWN"]) assert(!serialized.includes(secret));
  assert(!serialized.includes("Get-Content"));
  const line = formatStatusLine(status);
  assert(!line.includes("\n"));
  assert.match(line, /main gpt-5\.6-sol\/high/);
  assert.match(line, /workers 1 \(gpt-6-astra\/high\)/);
  assert.match(line, /mallo-helper/);
  assert(!line.includes("Codex-System:Mallo"));
  const full = formatStatus(status);
  assert.match(full, /Skills: real-skill, second-skill, mallo-helper/);
  assert(!full.includes("Codex-System:Mallo"));
  const statusReader = (sessionId) => getStatus(sessionId, { transcriptRoots: [root], now: () => Date.parse("2026-09-20T00:04:00Z") });
  const current = await currentActivity({ session_id: ROOT, phase: "progress" }, { statusReader });
  assert.equal(current.thread_id, ROOT);
  assert.equal(current.turn_id, TURN_ACTIVE);
  assert.equal(current.native_state, "active");
  assert(!current.line.includes("workers 1"));
  assert.equal(current.steps.length, 1);
  assert.equal(current.steps[0].task, "대화 작업");
  assert.match(current.markdown, /^> \*\*Mallo 작업요약\*\*/);
  assert(current.markdown.includes("> 대화 작업 \\(진행 중\\) · Sol\\/high ·"));
  assert.match(current.markdown, /mallo\\-helper/);
  assert(!current.markdown.includes("Codex-System:Mallo"));
  assert.match(current.markdown, /관찰 범위 일부/);
  assert(!/[>*]/.test(current.text));
  const activeSummary = await currentActivity({ session_id: ROOT, turn_id: TURN_ACTIVE, phase: "summary" }, { statusReader });
  assert.match(activeSummary.line, /마무리 시점 · 대화 작업/);
  assert(!activeSummary.line.includes("진행 중"));
  assert(!activeSummary.line.includes("응답 완료"));
  assert(!activeSummary.line.includes("성공"));
  assert.match(activeSummary.markdown, /^> \*\*Mallo 작업요약\*\*/);
  assert(!activeSummary.markdown.includes("응답 완료"));
  const completed = await currentActivity({ session_id: ROOT, turn_id: TURN_DONE, phase: "summary" }, { statusReader });
  assert.match(completed.line, /마무리 시점 · 네이티브 turn 응답 완료/);
  assert.equal(completed.steps.length, 2);
  assert.deepEqual(completed.steps.map((step) => [step.task, step.model, step.effort]), [
    ["대화 작업", "gpt-5.6-sol", "high"],
    ["compact presentation", "gpt-6-astra", "high"],
  ]);
  assert(!completed.line.includes("성공"));
  assert(completed.markdown.includes("> compact presentation · Astra\\/high · 읽기 기록 없음  "));
  const worker = await currentActivity({ session_id: CHILD, phase: "progress" }, { statusReader });
  assert.equal(worker.thread_id, CHILD);
  assert.equal(worker.turn_id, CHILD_TURN);
  assert.equal(worker.steps.length, 1);
  assert.equal(worker.steps[0].task, "compact presentation");
  assert.match(worker.line, /compact presentation · Astra\/high/);
  assert(!worker.line.includes("main gpt-5.6-sol"));
  const missing = await currentActivity({ session_id: ROOT, turn_id: CHILD_TURN, phase: "progress" }, { statusReader });
  assert.equal(missing.native_state, "unavailable");
  assert.equal(missing.turn_id, CHILD_TURN);
  assert.equal(missing.line, "Mallo · 관찰 불가");
  assert.equal(missing.text, "Mallo 작업요약\n\n관찰 불가");
  assert.deepEqual(missing.steps, []);
  assert.equal(missing.markdown, "> **Mallo 작업요약**\n>\n> 관찰 불가");
  const interrupted = await currentActivity({ session_id: ROOT, turn_id: TURN_OLD, phase: "progress" }, { statusReader });
  assert.equal(interrupted.native_state, "interrupted_or_unknown");
  assert.match(interrupted.line, /네이티브 turn 상태 확인 불가/);
  assert(!interrupted.line.includes("진행 중"));
  assert(interrupted.markdown.includes("대화 작업 \\(상태 확인 불가\\)"));
  const grouped = await listSessions({ transcriptRoots: [root] });
  assert.equal(grouped.find((item) => item.session_id === ROOT).thread_count, 2);
});

test("incremental and concurrent refreshes do not duplicate tools or turn history", async () => {
  const root = await fixtureRoot();
  const path = join(root, `rollout-${ROOT}.jsonl`);
  const startedSeconds = Date.parse("2026-09-20T01:00:00Z") / 1000;
  const completedSeconds = Date.parse("2026-09-20T01:01:00Z") / 1000;
  await writeJsonl(path, [sessionMeta(ROOT, ROOT), event("task_started", TURN_ACTIVE, startedSeconds), context(TURN_ACTIVE, "gpt-5.6-sol", "high"), response({ type: "function_call", name: "Bash", call_id: "call-one", arguments: "{}" })]);
  const first = await getStatus(ROOT, { transcriptRoots: [root] });
  assert.equal(first.history[0].tool_summary.running, 1);
  await appendFile(path, `${JSON.stringify(response({ type: "function_call_output", call_id: "call-one", output: JSON.stringify({ exit_code: 0 }) }))}\n${JSON.stringify(event("task_complete", TURN_ACTIVE, completedSeconds))}\n`);
  const statuses = await Promise.all(Array.from({ length: 8 }, () => getStatus(ROOT, { transcriptRoots: [root] })));
  for (const status of statuses) {
    assert.equal(status.history.length, 1);
    assert.equal(status.history[0].tools.length, 1);
    assert.equal(status.history[0].tool_summary.completed, 1);
    assert.equal(status.session.state, "native_turn_completed");
    assert.equal(status.current.model.value, "gpt-5.6-sol");
    assert.match(status.history[0].started_at, /^2026-09-20T01:00:00/);
  }
});

test("session isolation, explicit ids, no-read state, and symlink escape rejection", async (t) => {
  const root = await fixtureRoot();
  const outside = await fixtureRoot();
  await writeJsonl(join(root, `rollout-${ROOT}.jsonl`), [sessionMeta(ROOT, ROOT), event("task_started", TURN_DONE, "2026-09-20T02:00:00Z"), context(TURN_DONE, "gpt-5.6-sol", "medium"), event("task_complete", TURN_DONE, "2026-09-20T02:01:00Z")]);
  const escaped = join(outside, `rollout-${OTHER}.jsonl`);
  await writeJsonl(escaped, [sessionMeta(OTHER, OTHER)]);
  try { await symlink(escaped, join(root, `rollout-${OTHER}.jsonl`), "file"); }
  catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
    try { await symlink(outside, join(root, "outside-link"), "junction"); }
    catch (junctionError) {
      if (["EPERM", "EACCES"].includes(junctionError.code)) t.diagnostic("symlink and junction traversal checks are unavailable on this host");
      else throw junctionError;
    }
  }
  const sessions = await listSessions({ transcriptRoots: [root] });
  assert.deepEqual(sessions.map((item) => item.session_id), [ROOT]);
  const status = await getStatus(ROOT, { transcriptRoots: [root] });
  assert.equal(status.current.skills.state, "no_read_observed");
  await assert.rejects(() => getStatus("../outside", { transcriptRoots: [root] }), /Invalid session id/);
});

test("cyclic native parent metadata becomes a coverage warning", async () => {
  const root = await fixtureRoot();
  await writeJsonl(join(root, `rollout-${ROOT}.jsonl`), [sessionMeta(ROOT, ROOT, { parent_thread_id: CHILD })]);
  await writeJsonl(join(root, `rollout-${CHILD}.jsonl`), [sessionMeta(CHILD, ROOT, { parent_thread_id: ROOT })]);
  const status = await getStatus(ROOT, { transcriptRoots: [root] });
  assert.equal(status.coverage.state, "partial");
  assert(status.coverage.warnings.some((warning) => warning.code === "parent_cycle"));
});

test("reads only safe agent_path leaves from top-level and nested native metadata", async () => {
  const root = await fixtureRoot();
  await writeJsonl(join(root, `rollout-${ROOT}.jsonl`), [sessionMeta(ROOT, ROOT)]);
  await writeJsonl(join(root, `rollout-${TOP_PATH_CHILD}.jsonl`), [sessionMeta(TOP_PATH_CHILD, ROOT, { parent_thread_id: ROOT, agent_path: "/root/top_level_stage" })]);
  await writeJsonl(join(root, `rollout-${INVALID_PATH_CHILD}.jsonl`), [sessionMeta(INVALID_PATH_CHILD, ROOT, {
    source: { subagent: { thread_spawn: { parent_thread_id: ROOT, agent_path: "/root/bad\nlabel" } } },
  })]);
  const status = await getStatus(ROOT, { transcriptRoots: [root] });
  assert.equal(status.agents.find((agent) => agent.thread_id === TOP_PATH_CHILD).task_label, "top_level_stage");
  assert.equal(status.agents.find((agent) => agent.thread_id === INVALID_PATH_CHILD).task_label, null);
  assert(!JSON.stringify(status).includes("/root/"));
  assert(!JSON.stringify(status).includes("bad\\nlabel"));
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "mallo-activity-"));
  await mkdir(root, { recursive: true });
  return root;
}

async function writeJsonl(path, records, tail = "") {
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n${tail}`);
}

function sessionMeta(id, sessionId, extra = {}) {
  return { timestamp: "2026-09-20T00:00:00Z", type: "session_meta", payload: { id, session_id: sessionId, timestamp: "2026-09-20T00:00:00Z", ...extra } };
}
function context(turn_id, model, effort) { return { timestamp: "2026-09-20T00:00:01Z", type: "turn_context", payload: { turn_id, model, effort, unknown: true } }; }
function event(type, turn_id, timestamp) { return { timestamp, type: "event_msg", payload: { type, turn_id, ...(type === "task_started" ? { started_at: timestamp } : { completed_at: timestamp, duration_ms: 1000 }) } }; }
function response(payload) { return { timestamp: "2026-09-20T00:00:02Z", type: "response_item", payload }; }
function serializedSkillNames(status) { return status.agents.flatMap((agent) => agent.turns.flatMap((turn) => turn.skills.items.map((item) => item.name))); }
