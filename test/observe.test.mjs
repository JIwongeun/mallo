import assert from "node:assert/strict";
import test from "node:test";
import { currentActivity, observeActivity } from "../plugins/codex-system/lib/observe.mjs";

const SESSION = "019d3000-0000-7000-8000-000000000001";
const TURN = "019d3000-0000-7000-8000-000000000002";
const OLD_TURN = "019d3000-0000-7000-8000-000000000003";
const WORKER = "019d3000-0000-7000-8000-000000000004";

test("immediate prompt uses hook model without leaking a stale turn", async () => {
  const memory = new Map();
  const status = fixtureStatus({ includeCurrent: false });
  const output = await observeActivity(input("UserPromptSubmit"), memory, { statusReader: async () => status });
  assert.match(output.systemMessage, /활성 모델\(훅\) gpt-5\.6-sol\/effort 확인 대기/);
  assert.match(output.systemMessage, /스킬 관찰 대기/);
  assert(!output.systemMessage.includes("old-skill"));
  assert.deepEqual(await observeActivity(input("UserPromptSubmit"), memory, { statusReader: async () => status }), {});
});

test("emits only changed current-turn model, skill, and worker state", async () => {
  const memory = new Map();
  let status = fixtureStatus();
  const first = await observeActivity(input("PostToolUse"), memory, { statusReader: async () => status });
  assert.match(first.systemMessage, /gpt-6-astra\/xhigh/);
  assert.match(first.systemMessage, /스킬 읽기 요청 관찰 없음/);
  assert(!first.systemMessage.includes("old-skill"));
  assert.deepEqual(await observeActivity(input("PostToolUse"), memory, { statusReader: async () => status }), {});

  status = fixtureStatus({ skills: ["model-reasoning-router"], worker: "active" });
  const changed = await observeActivity(input("PostToolUse"), memory, { statusReader: async () => status });
  assert.match(changed.systemMessage, /스킬 참조 model-reasoning-router/);
  assert.match(changed.systemMessage, /보조 작업 gpt-6-astra\/xhigh 진행 중/);
});

test("Stop labels response end and keeps pending workers", async () => {
  const memory = new Map();
  const status = fixtureStatus({ worker: "active", tools: { total: 3, completed: 2, failed: 1 } });
  const stopped = await observeActivity(input("Stop"), memory, { statusReader: async () => status });
  assert.match(stopped.systemMessage, /응답 종료 시점/);
  assert.match(stopped.systemMessage, /보조 작업 gpt-6-astra\/xhigh 진행 중/);
  assert.match(stopped.systemMessage, /이번 turn 도구 2\/3/);
  assert(!stopped.systemMessage.includes("성공"));
  assert.deepEqual(await observeActivity(input("Stop"), memory, { statusReader: async () => status }), {});
});

test("current view keeps every in-window reused-worker turn while hooks stay per worker thread", async () => {
  const memory = new Map();
  const owner = turn(TURN, "native_turn_completed", [], "2026-09-20T01:00:00Z");
  owner.completed_at = "2026-09-20T02:00:00Z";
  const relevant = turn("019d3000-0000-7000-8000-000000000005", "native_turn_completed", ["worker-skill"], "2026-09-20T01:01:00Z");
  relevant.model = { value: "gpt-5.6-sol" };
  relevant.effort = { value: "high" };
  const second = turn("019d3000-0000-7000-8000-000000000007", "native_turn_completed", ["second-skill"], "2026-09-20T01:30:00Z");
  second.model = { value: "custom-model" };
  second.effort = { value: "medium" };
  const unrelated = turn("019d3000-0000-7000-8000-000000000006", "active", ["unrelated-skill"], "2026-09-20T03:00:00Z");
  const status = {
    session: { id: SESSION },
    coverage: { state: "complete" },
    history: [
      { ...owner, thread_id: SESSION, role: "main" },
      { ...relevant, thread_id: WORKER, role: "worker" },
      { ...second, thread_id: WORKER, role: "worker" },
      { ...unrelated, thread_id: WORKER, role: "worker" },
    ],
    agents: [
      { thread_id: SESSION, role: "main", turns: [owner] },
      { thread_id: WORKER, role: "worker", task_label: "code_implementation", turns: [relevant, second, unrelated] },
    ],
  };

  const mainOutput = await observeActivity(input("Stop"), memory, { statusReader: async () => status });
  assert.match(mainOutput.systemMessage, /code implementation custom-model\/medium/);
  assert.match(mainOutput.systemMessage, /second-skill/);
  assert(!mainOutput.systemMessage.includes("worker-skill"));
  assert(!mainOutput.systemMessage.includes("unrelated-skill"));

  const snapshot = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "summary" }, { statusReader: async () => status });
  assert.deepEqual(snapshot.steps.map((step) => [step.task, step.model, step.effort, step.skills]), [
    ["대화 작업", "gpt-6-astra", "xhigh", []],
    ["code implementation", "gpt-5.6-sol", "high", ["worker-skill"]],
    ["code implementation (2)", "custom-model", "medium", ["second-skill"]],
  ]);
  assert(!JSON.stringify(snapshot).includes("unrelated-skill"));

  const workerOutput = await observeActivity({ ...input("SubagentStop"), session_id: WORKER, turn_id: relevant.turn_id, agent_id: WORKER }, new Map(), { statusReader: async () => status });
  assert.match(workerOutput.systemMessage, /worker gpt-5\.6-sol\/high/);
  const workerSnapshot = await currentActivity({ session_id: WORKER, turn_id: relevant.turn_id, phase: "summary" }, { statusReader: async () => status });
  assert.deepEqual(workerSnapshot.steps.map((step) => step.turn_id), [relevant.turn_id]);
});

test("observer fails open and rejects control-character labels", async () => {
  const memory = new Map();
  const unavailable = await observeActivity(input("PostToolUse"), memory, { statusReader: async () => { throw new Error("SECRET_FAILURE"); } });
  assert.match(unavailable.systemMessage, /관찰 불가/);
  assert(!unavailable.systemMessage.includes("SECRET_FAILURE"));
  assert.deepEqual(await observeActivity({ ...input("PostToolUse"), model: "safe\u001b[31m" }, memory, { statusReader: async () => fixtureStatus() }), {});
  const snapshot = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "summary" }, { statusReader: async () => { throw new Error("SECRET_FAILURE"); } });
  assert.equal(snapshot.text, "Mallo 작업요약\n\n관찰 불가");
  assert.equal(snapshot.markdown, "> **Mallo 작업요약**\n>\n> 관찰 불가");
});

test("compact presentation hides only self reads and escapes untrusted Markdown labels", async () => {
  const selfOnly = fixtureStatus({ skills: ["MALLO", "Codex-System:Mallo"], worker: "active", workerSkills: ["mallo"] });
  const selfSnapshot = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "progress" }, { statusReader: async () => selfOnly });
  assert.equal(selfSnapshot.steps[0].skills.length, 0);
  assert.match(selfSnapshot.text, /읽기 기록 없음/);
  assert(!selfSnapshot.line.includes("Codex-System:Mallo"));
  const selfHook = await observeActivity(input("PostToolUse"), new Map(), { statusReader: async () => selfOnly });
  assert.match(selfHook.systemMessage, /스킬 읽기 요청 관찰 없음/);
  assert(!selfHook.systemMessage.includes("Codex-System:Mallo"));
  assert(selfOnly.agents[0].turns.at(-1).skills.items.some((item) => item.name === "MALLO"));
  assert(selfOnly.agents[1].turns.at(-1).skills.items.some((item) => item.name === "mallo"));

  const status = fixtureStatus({ skills: ["mallo-helper", "my-mallo", "safe](https://skills.invalid)"], worker: "active" });
  status.agents[0].turns.at(-1).model.value = "bad](https://model.invalid)";
  status.agents[0].turns.at(-1).effort.value = "x*high";
  const snapshot = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "summary" }, { statusReader: async () => status });
  assert.match(snapshot.line, /mallo-helper, my-mallo/);
  assert(snapshot.markdown.includes("bad\\]\\(https\\:\\/\\/model\\.invalid\\)"));
  assert(snapshot.markdown.includes("x\\*high"));
  assert(snapshot.markdown.includes("mallo\\-helper"));
  assert(!snapshot.markdown.includes("](https://"));
  assert(!snapshot.text.includes("> **"));
  assert(!snapshot.markdown.includes("대화 작업 \\(진행 중\\)"));
  for (const value of [snapshot.markdown, snapshot.text]) assert.doesNotMatch(value, /작업 · 모델\/effort · 참고 스킬|표시 순서는|스킬은 읽기 요청/);
  assert(snapshot.markdown.split("\n").every((line) => line.startsWith(">")));
  assert(!snapshot.markdown.includes("|---|"));
});

test("summary uses the fixed blockquote shape", async () => {
  const status = fixtureStatus({ completed: true, skills: ["caveman", "ponytail"] });
  status.agents[0].turns.at(-1).model.value = "gpt-5.6-sol";
  status.agents[0].turns.at(-1).effort.value = "high";
  const snapshot = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "summary" }, { statusReader: async () => status });
  assert.equal(snapshot.markdown, [
    "> **Mallo 작업요약**",
    ">",
    "> 대화 작업 · Sol\\/high · caveman\\, ponytail",
  ].join("\n"));
});

test("bounded presentation reports omitted work while snapshot retains all steps and skills", async () => {
  const owner = turn(TURN, "native_turn_completed", [], "2026-09-20T01:00:00Z");
  owner.completed_at = "2026-09-20T02:00:00Z";
  const workers = Array.from({ length: 7 }, (_, index) => {
    const suffix = String(index + 10).padStart(12, "0");
    const workerTurn = turn(`019d4000-0000-7000-8000-${suffix}`, index === 0 ? "interrupted_or_unknown" : "native_turn_completed", ["one", "two", "three", "four"], `2026-09-20T01:0${index + 1}:00Z`);
    return { thread_id: `019d5000-0000-7000-8000-${suffix}`, role: "worker", task_label: "parallel_task", turns: [workerTurn] };
  });
  const status = {
    coverage: { state: "partial" },
    history: [{ ...owner, thread_id: SESSION, role: "main" }],
    agents: [{ thread_id: SESSION, role: "main", turns: [owner] }, ...workers],
  };
  const snapshot = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "summary" }, { statusReader: async () => status });
  assert.equal(snapshot.steps.length, 8);
  assert.equal(snapshot.steps[1].skills.length, 4);
  assert.match(snapshot.markdown, /추가 2개 작업이 있습니다/);
  assert.match(snapshot.markdown, /축약된 스킬 기록이 있습니다/);
  assert(snapshot.markdown.includes("parallel task \\(상태 확인 불가\\)"));
  assert.match(snapshot.markdown, /관찰 범위 일부/);
  assert(snapshot.markdown.split("\n").every((line) => line.startsWith(">")));
});

function input(hook_event_name) { return { session_id: SESSION, turn_id: TURN, hook_event_name, model: "gpt-5.6-sol" }; }

function fixtureStatus(options = {}) {
  const old = turn(OLD_TURN, "native_turn_completed", ["old-skill"], "2026-09-20T00:00:00Z");
  const current = turn(TURN, options.completed ? "native_turn_completed" : "active", options.skills ?? [], "2026-09-20T01:00:00Z", options.tools);
  const history = [{ ...old, thread_id: SESSION, role: "main" }, ...(options.includeCurrent === false ? [] : [{ ...current, thread_id: SESSION, role: "main" }])];
  const agents = [{ thread_id: SESSION, role: "main", turns: options.includeCurrent === false ? [old] : [old, current] }];
  if (options.worker) agents.push({ thread_id: WORKER, role: "worker", turns: [turn("019d3000-0000-7000-8000-000000000005", options.worker, options.workerSkills ?? [], "2026-09-20T01:01:00Z")] });
  return { session: { id: SESSION }, history, agents, coverage: { state: "complete" } };
}

function turn(turn_id, state, skills, started_at, toolSummary) {
  return {
    turn_id, state, started_at, completed_at: state === "native_turn_completed" ? "2026-09-20T02:00:00Z" : null,
    model: { value: "gpt-6-astra" }, effort: { value: "xhigh" },
    skills: { items: skills.map((name) => ({ name })) },
    tool_summary: toolSummary ?? { total: 0, completed: 0, failed: 0 },
  };
}
