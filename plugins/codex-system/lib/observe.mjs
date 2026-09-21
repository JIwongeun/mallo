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
  const focused = input.phase === "progress" ? focusedStep(status, current, input.focus_task, input.task_labels) : null;
  if (input.phase === "progress" && input.focus_task && !focused) return pendingSnapshot(input, status.coverage.state);
  const steps = input.phase === "summary" ? scopedSteps(status, current, input.task_labels) : [focused ?? labeledStep(agent, current, input.task_labels)];
  const displayCurrent = input.phase === "progress" ? steps[0] : current;
  return {
    schema_version: 1,
    thread_id: input.session_id,
    turn_id: displayCurrent.turn_id ?? current.turn_id,
    native_state: displayCurrent.state ?? current.state,
    coverage: status.coverage.state,
    steps,
    line: formatLine(input.phase, displayCurrent, steps, status.coverage.state),
    text: formatText(steps, status.coverage.state),
    markdown: formatMarkdown(steps, status.coverage.state),
  };
}

export async function observeActivity(input, memory = new Map(), options = {}) {
  if (!validInput(input)) return {};
  let status;
  try { status = await (options.statusReader ?? getStatus)(input.session_id, options); }
  catch { return changed(memory, input, `Mallo · Activity unavailable · ${modelDisplayName(safe(input.model) ?? "model unknown")}/effort unknown`); }

  const found = status.history.find((turn) => turn.turn_id === input.turn_id) ?? null;
  const agent = found && status.agents.find((candidate) => candidate.thread_id === found.thread_id);
  const current = found ? { ...found, task_label: agent?.task_label } : null;
  const target = hookStep(status, current, input);
  const model = current?.model?.value ?? safe(input.model) ?? "model unknown";
  const effort = current?.effort?.value ?? "effort pending";
  const pieces = [`Mallo · ${eventState(input.hook_event_name, current)}`];
  if (target) pieces.push(formatStepLine(target));
  else if (["SubagentStart", "SubagentStop"].includes(input.hook_event_name) && input.agent_id) pieces.push("Worker observation pending");
  else pieces.push(`${modelDisplayName(model)}/${effort} · Active model (hook)`);
  if (["Stop", "Interrupt"].includes(input.hook_event_name) && current) pieces.push(`Turn tools ${current.tool_summary.completed}/${current.tool_summary.total}`);
  return changed(memory, input, pieces.join(" · "));
}

function scopedSteps(status, current, taskLabels) {
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
    const base = displayTaskName(agent, turn, taskLabels);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return stepView(agent, turn, count === 1 ? base : `${base} (${count})`);
  });
}

function focusedStep(status, current, focus, taskLabels) {
  const owner = status.agents.find((agent) => agent.thread_id === current.thread_id);
  if (!focus || focus === (current.role === "main" ? "main" : current.task_label)) return labeledStep(owner ?? current, current, taskLabels);
  if (current.role !== "main" || focus === "main") return null;
  const matches = status.agents
    .filter((agent) => agent.role === "worker" && agent.task_label === focus)
    .map((agent) => ({ agent, turns: relevantWorkerTurns(agent, current) }))
    .filter(({ turns }) => turns.length);
  if (matches.length !== 1) return null;
  return labeledStep(matches[0].agent, matches[0].turns.at(-1), taskLabels);
}

function hookStep(status, current, input) {
  if (["SubagentStart", "SubagentStop"].includes(input.hook_event_name) && input.agent_id) {
    const worker = status.agents.find((agent) => agent.role === "worker" && agent.thread_id === input.agent_id);
    if (!worker) return null;
    if (current?.role === "worker" && current.thread_id === worker.thread_id) return stepView(worker, current);
    const turn = relevantWorkerTurns(worker, current).at(-1);
    return turn ? stepView(worker, turn) : null;
  }
  if (!current) return null;
  const owner = status.agents.find((candidate) => candidate.thread_id === current.thread_id);
  return stepView(owner ?? current, current);
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
    role: displayRole(agent.role ?? turn.role),
    model: displayValue(turn.model?.value, "unknown"),
    effort: displayValue(turn.effort?.value, "unknown"),
    state: displayValue(turn.state, "unknown"),
    skills: (turn.skills?.items ?? []).map((item) => displayValue(item.name, null)).filter((name) => name && isVisibleSkillName(name)),
  };
}

function labeledStep(agent, turn, taskLabels) {
  return stepView(agent, turn, displayTaskName(agent, turn, taskLabels));
}

function displayTaskName(agent, turn, taskLabels) {
  const native = (agent.role ?? turn.role) === "main" ? "main" : agent.task_label;
  return labelForTask(taskLabels, native) ?? taskName(agent.role ?? turn.role, agent.task_label);
}

function formatLine(phase, current, steps, coverage) {
  const preview = steps.slice(0, PREVIEW_LIMIT).map((step) => formatStepLine(step));
  if (steps.length > PREVIEW_LIMIT) preview.push(`${steps.length - PREVIEW_LIMIT} more tasks`);
  if (steps.some((step) => step.skills.length > SKILL_PREVIEW_LIMIT)) preview.push("Skill list shortened");
  if (coverage !== "complete") preview.push(coverage === "unavailable" ? "Coverage unavailable" : "Partial coverage");
  return [`Mallo · ${snapshotState(phase, current)}`, ...preview].join(" · ");
}

function formatText(steps, coverage) {
  const lines = [];
  for (const step of steps.slice(0, PREVIEW_LIMIT)) lines.push(formatStepLine(step));
  const notes = summaryNotes(steps, coverage);
  if (notes.length) lines.push(...notes);
  return lines.join("\n");
}

function formatMarkdown(steps, coverage) {
  const lines = [];
  for (const step of steps.slice(0, PREVIEW_LIMIT)) {
    lines.push(`> ${markdownLabel(formatStepLine(step))}  `);
  }
  const notes = summaryNotes(steps, coverage);
  if (notes.length) lines.push(...notes.map((note) => `> ${markdownLabel(note)}`));
  return lines.join("\n").trimEnd();
}

function formatStepLine(step) {
  const skills = formatStepSkills(step.skills);
  const role = roleAlias(step.role);
  return `${modelDisplayName(step.model)}/${step.effort}${role ? ` (${role})` : ""} ${taskWithState(step)}${skills ? ` [${skills}]` : ""}`;
}

function taskWithState(step) {
  const state = usefulState(step.state);
  return state ? `${step.task} - ${state}` : step.task;
}

function usefulState(state) {
  if (state === "active") return null;
  if (["failed", "error", "cancelled"].includes(state)) return "failure recorded";
  if (state !== "native_turn_completed") return "state unavailable";
  return null;
}

function formatStepSkills(skills) {
  if (!skills.length) return "";
  return `${skills.slice(0, SKILL_PREVIEW_LIMIT).join(", ")}${skills.length > SKILL_PREVIEW_LIMIT ? ` +${skills.length - SKILL_PREVIEW_LIMIT}` : ""}`;
}

function summaryNotes(steps, coverage) {
  const notes = detailNotes(steps);
  if (coverage !== "complete") notes.push(`${coverage === "unavailable" ? "Coverage unavailable" : "Partial coverage"}.`);
  return notes;
}

function detailNotes(steps) {
  const notes = [];
  if (steps.length > PREVIEW_LIMIT) notes.push(`${steps.length - PREVIEW_LIMIT} more tasks. Request the full record to inspect them.`);
  if (steps.some((step) => step.skills.length > SKILL_PREVIEW_LIMIT)) notes.push("Skill lists were shortened. Request the full record to inspect them.");
  return notes;
}

function taskName(role, value) {
  if (role === "main") return "Main task";
  const label = displayTaskLabel(value);
  if (label) return label.replaceAll("_", " ");
  return role === "worker" ? "Subtask" : "Task";
}

function displayRole(value) {
  return value === "main" || value === "worker" ? value : null;
}

function roleAlias(role) {
  if (role === "main") return "main";
  if (role === "worker") return "sub";
  return null;
}

function labelForTask(labels, native) {
  return native && Object.hasOwn(labels ?? {}, native) ? displayTaskLabel(labels[native]) : null;
}

function eventState(event, current) {
  if (event === "Stop") return current?.state === "native_turn_completed" ? "Native turn completed" : "Response end";
  if (event === "Interrupt") return "Interrupted";
  if (event === "SubagentStop") return "Worker stopped";
  if (event === "SubagentStart") return "Worker started";
  return current?.state === "native_turn_completed" ? "Native turn completed" : "In progress";
}

function snapshotState(phase, current) {
  if (current.state === "native_turn_completed") return `${phase === "summary" ? "Completion checkpoint" : "Latest record"} · Native turn completed`;
  if (current.state === "active") return phase === "summary" ? "Completion checkpoint" : "In progress";
  return `${phase === "summary" ? "Completion checkpoint · " : ""}Native turn state unavailable`;
}

function modelDisplayName(model) {
  if (model === "gpt-6-astra") return "GPT-6-Astra";
  if (model === "gpt-5.6-sol") return "GPT-5.6-Sol";
  return model;
}

function markdownLabel(value) {
  return String(value).replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "\\$&");
}

function unavailableSnapshot(input) {
  const line = `Mallo · ${input.phase === "summary" ? "Completion checkpoint · " : ""}Activity unavailable`;
  return {
    schema_version: 1,
    thread_id: input.session_id,
    turn_id: input.turn_id ?? null,
    native_state: "unavailable",
    coverage: "unavailable",
    steps: [],
    line,
    text: "Activity unavailable",
    markdown: "> Activity unavailable",
  };
}

function pendingSnapshot(input, coverage) {
  const task = labelForTask(input.task_labels, input.focus_task) ?? taskName(input.focus_task === "main" ? "main" : "worker", input.focus_task);
  return {
    schema_version: 1,
    thread_id: input.session_id,
    turn_id: null,
    native_state: "unavailable",
    coverage,
    steps: [],
    line: `Mallo · Observation pending · ${task}`,
    text: `${task} observation pending`,
    markdown: `> ${markdownLabel(task)} observation pending`,
  };
}

function validateCurrentInput(input) {
  if (!input || typeof input !== "object" || !ID.test(input.session_id ?? "")) throw new Error("current activity requires a valid session_id");
  if (!["progress", "summary"].includes(input.phase)) throw new Error("current activity phase must be progress or summary");
  if (input.turn_id != null && !ID.test(input.turn_id)) throw new Error("current activity turn_id must be a native UUID");
  if (input.focus_task != null) {
    if (input.phase !== "progress") throw new Error("current activity focus_task requires phase progress");
    if (!displayValue(input.focus_task, null)) throw new Error("current activity focus_task must be a safe native task label");
  }
  if (input.task_labels != null) {
    if (typeof input.task_labels !== "object" || Array.isArray(input.task_labels) || Object.keys(input.task_labels).length > 32) throw new Error("current activity task_labels must be a small object");
    // Invalid display aliases are ignored; native task keys remain available for exact lookup.
  }
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

function displayTaskLabel(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 80 && /^[\x20-\x7e]+$/u.test(value) ? value.replace(/\s+/g, " ").trim() : null;
}

function safe(value) { return displayValue(value, null); }
