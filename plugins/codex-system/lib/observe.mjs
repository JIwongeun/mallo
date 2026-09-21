import { getStatus, isVisibleSkillName } from "./activity.mjs";

const EVENTS = new Set(["UserPromptSubmit", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "Interrupt"]);
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PREVIEW_LIMIT = 6;
const SKILL_PREVIEW_LIMIT = 3;

export async function currentActivity(input, options = {}) {
  validateCurrentInput(input);
  let status;
  try { status = await (options.statusReader ?? getStatus)(input.session_id, options); }
  catch { return unavailableSnapshot(input); }

  const agent = status.agents.find((candidate) => candidate.thread_id === input.session_id);
  const turn = input.turn_id
    ? agent?.turns.find((candidate) => candidate.turn_id === input.turn_id)
    : agent?.turns.at(-1);
  if (!agent || !turn) return unavailableSnapshot(input);

  const current = { ...turn, thread_id: agent.thread_id, role: agent.role, task_label: agent.task_label };
  const steps = scopedSteps(status, current);
  return {
    schema_version: 1,
    thread_id: input.session_id,
    turn_id: current.turn_id,
    native_state: current.state,
    coverage: status.coverage.state,
    steps,
    line: formatLine(input.phase, current, steps, status.coverage.state),
    text: formatText(steps, status.coverage.state, input.phase),
    markdown: formatMarkdown(steps, status.coverage.state, input.phase),
  };
}

export async function observeActivity(input, memory = new Map(), options = {}) {
  if (!validInput(input)) return {};
  let status;
  try { status = await (options.statusReader ?? getStatus)(input.session_id, options); }
  catch { return changed(memory, input, `Mallo · 관찰 불가 · ${safe(input.model) ?? "model 확인 불가"}/effort 확인 불가`); }

  const found = status.history.find((turn) => turn.turn_id === input.turn_id) ?? null;
  const agent = found && status.agents.find((candidate) => candidate.thread_id === found.thread_id);
  const current = found ? { ...found, task_label: agent?.task_label } : null;
  const workers = scopedHookWorkers(status, current, input.agent_id);
  const model = current?.model?.value ?? safe(input.model) ?? "model 확인 불가";
  const effort = current?.effort?.value ?? "effort 확인 대기";
  const skills = scopedSkills(current, workers);
  const pieces = [`Mallo · ${eventState(input.hook_event_name, current)}`, `${current ? current.role : "활성 모델(훅)"} ${model}/${effort}`];
  if (workers.length) pieces.push(formatHookWorkers(workers));
  else if (input.hook_event_name === "SubagentStart" && input.agent_id) pieces.push("worker 시작 관찰 대기");
  pieces.push(formatHookSkills(skills, current, status.coverage.state));
  if (["Stop", "Interrupt"].includes(input.hook_event_name) && current) pieces.push(`이번 turn 도구 ${current.tool_summary.completed}/${current.tool_summary.total}`);
  return changed(memory, input, pieces.join(" · "));
}

function scopedSteps(status, current) {
  const ownerAgent = status.agents.find((agent) => agent.thread_id === current.thread_id);
  const entries = [{ agent: ownerAgent ?? current, turn: current }];
  if (current.role === "main" && current.started_at) {
    for (const agent of status.agents.filter((candidate) => candidate.role === "worker")) {
      for (const turn of relevantWorkerTurns(agent, current)) entries.push({ agent, turn });
    }
  }
  entries.sort((left, right) => {
    if (left.turn.turn_id === current.turn_id) return -1;
    if (right.turn.turn_id === current.turn_id) return 1;
    return (left.turn.started_at ?? "").localeCompare(right.turn.started_at ?? "")
      || (left.agent.thread_id ?? "").localeCompare(right.agent.thread_id ?? "")
      || (left.turn.turn_id ?? "").localeCompare(right.turn.turn_id ?? "");
  });
  const seen = new Map();
  return entries.map(({ agent, turn }) => {
    const base = taskName(agent.role ?? turn.role, agent.task_label);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return stepView(agent, turn, count === 1 ? base : `${base} (${count})`);
  });
}

function scopedHookWorkers(status, current, agentId) {
  const workers = status.agents.filter((agent) => agent.role === "worker");
  if (agentId) {
    const exact = workers.find((agent) => agent.thread_id === agentId);
    const relevant = exact && relevantWorkerTurns(exact, current).at(-1);
    if (exact && relevant && !(current?.role === "worker" && current.thread_id === exact.thread_id)) return [stepView(exact, relevant)];
  }
  if (!current?.started_at || current.role !== "main") return [];
  return workers.flatMap((agent) => {
    const turn = relevantWorkerTurns(agent, current).at(-1);
    return turn ? [stepView(agent, turn)] : [];
  });
}

function relevantWorkerTurns(agent, ownerTurn) {
  if (!ownerTurn?.started_at) return [];
  const start = Date.parse(ownerTurn.started_at);
  const end = ownerTurn.completed_at ? Date.parse(ownerTurn.completed_at) : Infinity;
  return agent.turns.filter((turn) => {
    const at = Date.parse(turn.started_at ?? "");
    return Number.isFinite(at) && at >= start && at <= end;
  });
}

function stepView(agent, turn, task = taskName(agent.role ?? turn.role, agent.task_label)) {
  return {
    task,
    thread_id: agent.thread_id ?? turn.thread_id,
    turn_id: turn.turn_id,
    role: agent.role ?? turn.role ?? "worker",
    model: displayValue(turn.model?.value, "unknown"),
    effort: displayValue(turn.effort?.value, "unknown"),
    state: displayValue(turn.state, "unknown"),
    skills: (turn.skills?.items ?? []).map((item) => displayValue(item.name, null)).filter((name) => name && isVisibleSkillName(name)),
  };
}

function scopedSkills(current, workers) {
  return [...new Set([
    ...(current?.skills?.items ?? []).map((item) => item.name),
    ...workers.flatMap((worker) => worker.skills),
  ].map((name) => displayValue(name, null)).filter((name) => name && isVisibleSkillName(name)))];
}

function formatLine(phase, current, steps, coverage) {
  const preview = steps.slice(0, PREVIEW_LIMIT).map((step, index) => formatStepLine(step, phase, index));
  if (steps.length > PREVIEW_LIMIT) preview.push(`추가 ${steps.length - PREVIEW_LIMIT}개 작업 있음`);
  if (steps.some((step) => step.skills.length > SKILL_PREVIEW_LIMIT)) preview.push("축약된 스킬 기록 있음");
  if (coverage !== "complete") preview.push(coverage === "unavailable" ? "관찰 범위 확인 불가" : "관찰 범위 일부");
  return [`Mallo · ${snapshotState(phase, current)}`, ...preview].join(" · ");
}

function formatText(steps, coverage, phase) {
  const lines = ["Mallo 작업요약", ""];
  for (const [index, step] of steps.slice(0, PREVIEW_LIMIT).entries()) lines.push(formatStepLine(step, phase, index));
  const notes = summaryNotes(steps, coverage);
  if (notes.length) lines.push("", ...notes);
  return lines.join("\n");
}

function formatMarkdown(steps, coverage, phase) {
  const lines = ["> **Mallo 작업요약**", ">"];
  for (const [index, step] of steps.slice(0, PREVIEW_LIMIT).entries()) {
    lines.push(`> ${markdownLabel(taskWithState(step, phase, index))} · ${markdownLabel(`${modelAlias(step.model)}/${step.effort}`)} · ${markdownLabel(formatStepSkills(step.skills))}  `);
  }
  const notes = summaryNotes(steps, coverage);
  if (notes.length) lines.push(">", ...notes.map((note) => `> ${markdownLabel(note)}`));
  return lines.join("\n").trimEnd();
}

function formatStepLine(step, phase = "progress", index = -1) {
  return `${taskWithState(step, phase, index)} · ${modelAlias(step.model)}/${step.effort} · ${formatStepSkills(step.skills)}`;
}

function taskWithState(step, phase, index) {
  const state = usefulState(step.state, phase === "summary" && index === 0);
  return state ? `${step.task} (${state})` : step.task;
}

function usefulState(state, suppressActive = false) {
  if (state === "active") return suppressActive ? null : "진행 중";
  if (["failed", "error", "cancelled"].includes(state)) return "실패 기록";
  if (state !== "native_turn_completed") return "상태 확인 불가";
  return null;
}

function formatStepSkills(skills) {
  if (!skills.length) return "읽기 기록 없음";
  return `${skills.slice(0, SKILL_PREVIEW_LIMIT).join(", ")}${skills.length > SKILL_PREVIEW_LIMIT ? ` +${skills.length - SKILL_PREVIEW_LIMIT}` : ""}`;
}

function summaryNotes(steps, coverage) {
  const notes = detailNotes(steps);
  if (coverage !== "complete") notes.push(`${coverage === "unavailable" ? "관찰 범위 확인 불가" : "관찰 범위 일부"}.`);
  return notes;
}

function detailNotes(steps) {
  const notes = [];
  if (steps.length > PREVIEW_LIMIT) notes.push(`추가 ${steps.length - PREVIEW_LIMIT}개 작업이 있습니다. 전체 작업 기록을 요청하면 확인할 수 있습니다.`);
  if (steps.some((step) => step.skills.length > SKILL_PREVIEW_LIMIT)) notes.push("축약된 스킬 기록이 있습니다. 전체 작업 기록을 요청하면 확인할 수 있습니다.");
  return notes;
}

function taskName(role, value) {
  if (role === "main") return "대화 작업";
  const label = displayValue(value, null);
  return label ? label.replaceAll("_", " ").replace(/\s+/g, " ").trim() || "보조 작업" : "보조 작업";
}

function formatHookWorkers(workers) {
  const preview = workers.slice(0, 3).map((worker) => `${worker.task} ${worker.model}/${worker.effort}${usefulState(worker.state) ? ` ${usefulState(worker.state)}` : ""}`);
  return `${preview.join(", ")}${workers.length > 3 ? ` +${workers.length - 3}` : ""}`;
}

function formatHookSkills(skills, current, coverage) {
  if (skills.length) return `스킬 참조 ${skills.slice(0, 3).join(", ")}${skills.length > 3 ? ` +${skills.length - 3}` : ""} (읽기 요청 흔적)`;
  if (!current || coverage !== "complete") return "스킬 관찰 대기";
  return "스킬 읽기 요청 관찰 없음";
}

function eventState(event, current) {
  if (event === "Stop") return current?.state === "native_turn_completed" ? "네이티브 turn 응답 완료" : "응답 종료 시점";
  if (event === "Interrupt") return "중단 시점";
  if (event === "SubagentStop") return "worker 종료 시점";
  if (event === "SubagentStart") return "worker 시작 시점";
  return current?.state === "native_turn_completed" ? "네이티브 turn 응답 완료" : "진행 중";
}

function snapshotState(phase, current) {
  if (current.state === "native_turn_completed") return `${phase === "summary" ? "마무리 시점" : "최근 기록"} · 네이티브 turn 응답 완료`;
  if (current.state === "active") return phase === "summary" ? "마무리 시점" : "진행 중";
  return `${phase === "summary" ? "마무리 시점 · " : ""}네이티브 turn 상태 확인 불가`;
}

function modelAlias(model) {
  if (model === "gpt-6-astra") return "Astra";
  if (model === "gpt-5.6-sol") return "Sol";
  return model;
}

function markdownLabel(value) {
  return String(value).replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "\\$&");
}

function unavailableSnapshot(input) {
  const line = `Mallo · ${input.phase === "summary" ? "마무리 시점 · " : ""}관찰 불가`;
  return {
    schema_version: 1,
    thread_id: input.session_id,
    turn_id: input.turn_id ?? null,
    native_state: "unavailable",
    coverage: "unavailable",
    steps: [],
    line,
    text: "Mallo 작업요약\n\n관찰 불가",
    markdown: "> **Mallo 작업요약**\n>\n> 관찰 불가",
  };
}

function validateCurrentInput(input) {
  if (!input || typeof input !== "object" || !ID.test(input.session_id ?? "")) throw new Error("current activity requires a valid session_id");
  if (!["progress", "summary"].includes(input.phase)) throw new Error("current activity phase must be progress or summary");
  if (input.turn_id != null && !ID.test(input.turn_id)) throw new Error("current activity turn_id must be a native UUID");
}

function changed(memory, input, line) {
  const key = `${input.session_id}:${input.turn_id}`;
  const terminal = ["Stop", "Interrupt", "SubagentStop"].includes(input.hook_event_name);
  const fingerprint = terminal ? `${input.hook_event_name}:${input.agent_id ?? ""}:${line}` : line;
  const seen = memory.get(key) ?? new Set();
  if (seen.has(fingerprint)) return {};
  if (!terminal) for (const value of seen) if (!value.startsWith("Stop:") && !value.startsWith("Interrupt:") && !value.startsWith("SubagentStop:")) seen.delete(value);
  seen.add(fingerprint);
  memory.set(key, seen);
  return { systemMessage: line };
}

function validInput(input) {
  if (!input || typeof input !== "object" || !ID.test(input.session_id ?? "") || !ID.test(input.turn_id ?? "") || !EVENTS.has(input.hook_event_name)) return false;
  if (input.agent_id != null && !ID.test(input.agent_id)) return false;
  return input.model == null || safe(input.model) != null;
}

function displayValue(value, fallback) {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : fallback;
}

function safe(value) { return displayValue(value, null); }
