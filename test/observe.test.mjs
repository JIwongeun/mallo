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
  assert.match(output.systemMessage, /GPT-5\.6-Sol\/effort pending · Active model \(hook\)/);
  assert(!output.systemMessage.includes("Skill reads"));
  assert(!output.systemMessage.includes("old-skill"));
  assert.deepEqual(await observeActivity(input("UserPromptSubmit"), memory, { statusReader: async () => status }), {});
});

test("display names leave unknown and versioned model IDs and raw metadata unchanged", async () => {
  for (const model of ["vendor/model-v2", "gpt-6-astra-2026-09-21", "gpt-5.6-sol-2026-09-21"]) {
    const status = fixtureStatus();
    status.agents[0].turns.at(-1).model.value = model;
    const snapshot = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "summary" }, { statusReader: async () => status });
    assert.equal(snapshot.steps[0].model, model);
    assert(snapshot.text.startsWith(`${model}/xhigh`));
    assert.equal(status.history.at(-1).model.value, model);
    const hook = await observeActivity(input("PostToolUse"), new Map(), { statusReader: async () => status });
    assert(hook.systemMessage.includes(`${model}/xhigh (main)`));
    const hookOnly = await observeActivity({ ...input("UserPromptSubmit"), model }, new Map(), { statusReader: async () => fixtureStatus({ includeCurrent: false }) });
    assert(hookOnly.systemMessage.includes(`${model}/effort pending`));
    const unavailable = await observeActivity({ ...input("PostToolUse"), model }, new Map(), { statusReader: async () => { throw new Error("reader failed"); } });
    assert(unavailable.systemMessage.includes(`${model}/effort unknown`));
  }
});

test("emits only changed current-turn model, skill, and worker state", async () => {
  const memory = new Map();
  let status = fixtureStatus();
  const first = await observeActivity(input("PostToolUse"), memory, { statusReader: async () => status });
  assert.match(first.systemMessage, /GPT-6-Astra\/xhigh/);
  assert.match(first.systemMessage, /GPT-6-Astra\/xhigh \(main\) Main task/);
  assert(!first.systemMessage.includes("Skill reads"));
  assert(!first.systemMessage.includes("old-skill"));
  assert.deepEqual(await observeActivity(input("PostToolUse"), memory, { statusReader: async () => status }), {});

  status = fixtureStatus({ skills: ["model-reasoning-router"], worker: "active" });
  const changed = await observeActivity(input("PostToolUse"), memory, { statusReader: async () => status });
  assert.match(changed.systemMessage, /GPT-6-Astra\/xhigh \(main\) Main task \[model-reasoning-router\]/);
  assert(!changed.systemMessage.includes("Subtask"));
});

test("Stop labels the owner response end without aggregating workers", async () => {
  const memory = new Map();
  const status = fixtureStatus({ worker: "active", tools: { total: 3, completed: 2, failed: 1 } });
  const stopped = await observeActivity(input("Stop"), memory, { statusReader: async () => status });
  assert.match(stopped.systemMessage, /Response end/);
  assert.match(stopped.systemMessage, /GPT-6-Astra\/xhigh \(main\) Main task/);
  assert(!stopped.systemMessage.includes("Skill reads"));
  assert(!stopped.systemMessage.includes("Subtask"));
  assert.match(stopped.systemMessage, /Turn tools 2\/3/);
  assert(!stopped.systemMessage.includes("success"));
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
  assert.match(mainOutput.systemMessage, /GPT-6-Astra\/xhigh \(main\) Main task/);
  assert(!mainOutput.systemMessage.includes("second-skill"));
  assert(!mainOutput.systemMessage.includes("worker-skill"));
  assert(!mainOutput.systemMessage.includes("unrelated-skill"));

  const snapshot = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "summary" }, { statusReader: async () => status });
  assert.deepEqual(snapshot.steps.map((step) => [step.task, step.model, step.effort, step.skills]), [
    ["Main task", "gpt-6-astra", "xhigh", []],
    ["code implementation", "gpt-5.6-sol", "high", ["worker-skill"]],
    ["code implementation (2)", "custom-model", "medium", ["second-skill"]],
  ]);
  assert(!JSON.stringify(snapshot).includes("unrelated-skill"));

  const focused = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "progress", focus_task: "code_implementation" }, { statusReader: async () => status });
  assert.deepEqual(focused.steps.map((step) => [step.turn_id, step.model, step.skills]), [
    [second.turn_id, "custom-model", ["second-skill"]],
  ]);

  const duplicate = {
    thread_id: "019d3000-0000-7000-8000-000000000099",
    role: "worker",
    task_label: "code_implementation",
    turns: [turn("019d3000-0000-7000-8000-000000000098", "native_turn_completed", ["outside-skill"], "2026-09-20T03:00:00Z")],
  };
  status.agents.push(duplicate);
  const ignoresOutsideWindow = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "progress", focus_task: "code_implementation" }, { statusReader: async () => status });
  assert.equal(ignoresOutsideWindow.steps[0].turn_id, second.turn_id);
  duplicate.turns[0].started_at = "2026-09-20T01:15:00Z";
  const ambiguous = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "progress", focus_task: "code_implementation" }, { statusReader: async () => status });
  assert.deepEqual(ambiguous.steps, []);
  assert.match(ambiguous.text, /code implementation observation pending/);

  const workerOutput = await observeActivity({ ...input("SubagentStop"), session_id: WORKER, turn_id: relevant.turn_id, agent_id: WORKER }, new Map(), { statusReader: async () => status });
  assert.match(workerOutput.systemMessage, /GPT-5.6-Sol\/high \(sub\) code implementation \[worker-skill\]/);
  const workerSnapshot = await currentActivity({ session_id: WORKER, turn_id: relevant.turn_id, phase: "summary" }, { statusReader: async () => status });
  assert.deepEqual(workerSnapshot.steps.map((step) => step.turn_id), [relevant.turn_id]);
});

test("observer fails open and rejects control-character labels", async () => {
  const memory = new Map();
  const unavailable = await observeActivity(input("PostToolUse"), memory, { statusReader: async () => { throw new Error("SECRET_FAILURE"); } });
  assert.match(unavailable.systemMessage, /Activity unavailable/);
  assert.match(unavailable.systemMessage, /GPT-5\.6-Sol\/effort unknown/);
  assert(!unavailable.systemMessage.includes("SECRET_FAILURE"));
  assert.deepEqual(await observeActivity({ ...input("PostToolUse"), model: "safe\u001b[31m" }, memory, { statusReader: async () => fixtureStatus() }), {});
  const snapshot = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "summary" }, { statusReader: async () => { throw new Error("SECRET_FAILURE"); } });
  assert.equal(snapshot.text, "Activity unavailable");
  assert.equal(snapshot.markdown, "> Activity unavailable");
});

test("compact presentation hides only self reads and escapes untrusted Markdown labels", async () => {
  const selfOnly = fixtureStatus({ skills: ["MALLO", "Codex-System:Mallo"], worker: "active", workerSkills: ["mallo"] });
  const selfSnapshot = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "progress" }, { statusReader: async () => selfOnly });
  assert.equal(selfSnapshot.steps[0].skills.length, 0);
  assert.match(selfSnapshot.text, /GPT-6-Astra\/xhigh \(main\) Main task/);
  assert(!selfSnapshot.text.includes("Skill reads"));
  assert(!selfSnapshot.line.includes("Codex-System:Mallo"));
  const selfHook = await observeActivity(input("PostToolUse"), new Map(), { statusReader: async () => selfOnly });
  assert.match(selfHook.systemMessage, /GPT-6-Astra\/xhigh \(main\) Main task/);
  assert(!selfHook.systemMessage.includes("Skill reads"));
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
  assert(!snapshot.markdown.includes("Main task \\(In progress\\)"));
  for (const value of [snapshot.markdown, snapshot.text]) assert.doesNotMatch(value, /display order|skills prove application/i);
  assert(snapshot.markdown.split("\n").every((line) => line.startsWith(">")));
  assert(!snapshot.markdown.includes("|---|"));
});

test("summary uses headerless task rows", async () => {
  const status = fixtureStatus({ completed: true, skills: ["caveman", "ponytail"] });
  status.agents[0].turns.at(-1).model.value = "gpt-5.6-sol";
  status.agents[0].turns.at(-1).effort.value = "high";
  const snapshot = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "summary" }, { statusReader: async () => status });
  assert.equal(snapshot.markdown, [
    "> GPT\\-5\\.6\\-Sol\\/high \\(main\\) Main task \\[caveman\\, ponytail\\]",
  ].join("\n"));
});

test("missing native role does not invent a main or sub marker", async () => {
  const status = fixtureStatus({ skills: ["caveman"] });
  status.agents[0].role = undefined;
  status.history.at(-1).role = undefined;
  const snapshot = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "progress" }, { statusReader: async () => status });
  assert.equal(snapshot.steps[0].role, null);
  assert.equal(snapshot.text, "GPT-6-Astra/xhigh Task [caveman]");
  assert(!/\((?:main|sub)\)/.test(snapshot.line));
});

test("current view uses English aliases for native task keys and ignores invalid aliases", async () => {
  const status = fixtureStatus({ skills: ["main-skill"], worker: "active", workerSkills: ["worker-skill"] });
  status.agents[1].task_label = "구현_작업";
  status.agents[1].turns[0].model = { value: "gpt-5.6-sol" };
  status.agents[1].turns[0].effort = { value: "high" };
  const snapshot = await currentActivity({
    session_id: SESSION,
    turn_id: TURN,
    phase: "progress",
    task_labels: {
      main: "Requirements <review>",
      구현_작업: "Implementation](https://labels.invalid)",
      unknown_worker: "Pending task",
    },
  }, { statusReader: async () => status });

  assert.equal(snapshot.text.split("\n", 1)[0], "GPT-6-Astra/xhigh (main) Requirements <review> [main-skill]");
  assert.deepEqual(snapshot.steps.map((step) => [step.task, step.model, step.effort, step.skills]), [
    ["Requirements <review>", "gpt-6-astra", "xhigh", ["main-skill"]],
  ]);
  const focused = await currentActivity({
    session_id: SESSION,
    turn_id: TURN,
    phase: "progress",
    focus_task: "구현_작업",
    task_labels: { 구현_작업: "Implementation](https://labels.invalid)" },
  }, { statusReader: async () => status });
  assert.deepEqual(focused.steps.map((step) => [step.task, step.model, step.effort, step.skills]), [
    ["Implementation](https://labels.invalid)", "gpt-5.6-sol", "high", ["worker-skill"]],
  ]);
  assert(!JSON.stringify(snapshot).includes("Pending task"));
  assert(snapshot.markdown.includes("Requirements \\<review\\>"));
  assert(!focused.markdown.includes("](https://labels.invalid)"));

  const summary = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "summary", task_labels: { 구현_작업: "Implementation review" } }, { statusReader: async () => status });
  assert.match(summary.text, /GPT-5.6-Sol\/high \(sub\) Implementation review \[worker-skill\]/);
  assert(!summary.text.includes("구현_작업"));
  const noAlias = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "progress", focus_task: "구현_작업" }, { statusReader: async () => status });
  assert.equal(noAlias.steps[0].task, "Subtask");
  const invalidAlias = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "progress", focus_task: "구현_작업", task_labels: { 구현_작업: "잘못된 별칭" } }, { statusReader: async () => status });
  assert.equal(invalidAlias.text, "GPT-5.6-Sol/high (sub) Subtask [worker-skill]");
  const hook = await observeActivity({ ...input("SubagentStart"), agent_id: WORKER }, new Map(), { statusReader: async () => status });
  assert.match(hook.systemMessage, /GPT-5.6-Sol\/high \(sub\) Subtask \[worker-skill\]/);
  assert(!/[가-힣]/u.test([snapshot.text, focused.text, summary.text, noAlias.text, invalidAlias.text, hook.systemMessage].join(" ")));

  const pending = await currentActivity({
    session_id: SESSION,
    turn_id: TURN,
    phase: "progress",
    focus_task: "unknown_worker",
    task_labels: { unknown_worker: "Pending task" },
  }, { statusReader: async () => status });
  assert.deepEqual(pending.steps, []);
  assert.match(pending.text, /Pending task observation pending/);
  await assert.rejects(
    currentActivity({ session_id: SESSION, turn_id: TURN, phase: "summary", focus_task: "main" }, { statusReader: async () => status }),
    /focus_task requires phase progress/,
  );
  for (const focus_task of ["bad\nfocus", "x".repeat(161)]) {
    await assert.rejects(
      currentActivity({ session_id: SESSION, turn_id: TURN, phase: "progress", focus_task }, { statusReader: async () => status }),
      /focus_task/,
    );
  }

  for (const task_labels of [
    [],
    Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`unknown_${index}`, "label"])),
  ]) {
    await assert.rejects(
      currentActivity({ session_id: SESSION, turn_id: TURN, phase: "progress", task_labels }, { statusReader: async () => status }),
      /task_labels/,
    );
  }
  for (const task_labels of [{ main: "bad\nlabel" }, { main: "x".repeat(81) }, { main: "한국어" }, { main: null }, { "bad\nkey": "label" }]) {
    const fallback = await currentActivity({ session_id: SESSION, turn_id: TURN, phase: "progress", task_labels }, { statusReader: async () => status });
    assert.equal(fallback.steps[0].task, "Main task");
  }
});

test("SubagentStart waits for exact worker metadata before showing a route", async () => {
  const pending = fixtureStatus();
  const waiting = await observeActivity({ ...input("SubagentStart"), agent_id: WORKER }, new Map(), { statusReader: async () => pending });
  assert.match(waiting.systemMessage, /Worker observation pending/);
  assert(!waiting.systemMessage.includes("requested"));

  const observed = fixtureStatus({ worker: "active", workerSkills: ["caveman"] });
  observed.agents[1].task_label = "cli_hook_verification";
  observed.agents[1].turns[0].model = { value: "gpt-6-astra" };
  observed.agents[1].turns[0].effort = { value: "xhigh" };
  const visible = await observeActivity({ ...input("SubagentStart"), agent_id: WORKER }, new Map(), { statusReader: async () => observed });
  assert.match(visible.systemMessage, /GPT-6-Astra\/xhigh \(sub\) cli hook verification \[caveman\]/);
  assert(!visible.systemMessage.includes("requested gpt-5.6-sol/high"));
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
  assert.match(snapshot.markdown, /2 more tasks/);
  assert.match(snapshot.markdown, /Skill lists were shortened/);
  assert(snapshot.markdown.includes("parallel task \\- state unavailable"));
  assert.match(snapshot.markdown, /Partial coverage/);
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
