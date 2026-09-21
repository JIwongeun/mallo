import { open, opendir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, relative, resolve, sep } from "node:path";

export const STATUS_SCHEMA_VERSION = 1;

const ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MALLO_TOOLS = new Set(["show_activity", "task_summary", "list_activity", "observe_activity", "mcp__mallo__show_activity", "mcp__mallo__task_summary", "mcp__mallo__list_activity", "mcp__mallo__observe_activity"]);
const SELF_SKILLS = new Set(["mallo", "mallo:mallo", "codex-system:mallo"]);
const headerCache = new Map();
const transcriptCache = new Map();
const transcriptLocks = new Map();

export async function getStatus(sessionId, options = {}) {
  assertId(sessionId, "session id");
  const roots = await transcriptRoots(options);
  const catalog = await readCatalog(roots);
  const byId = new Map(catalog.map((entry) => [entry.meta.id, entry.meta]));
  const selected = catalog.find((entry) => entry.meta.id === sessionId || entry.meta.session_id === sessionId);
  const selectedAncestry = selected ? ancestry(selected.meta.id, byId) : { root: sessionId, warning: null };
  const canonicalSessionId = selectedAncestry.root;
  const relatedCatalog = catalog.map((entry) => ({ entry, ancestry: ancestry(entry.meta.id, byId) }));
  const associatedEntries = relatedCatalog.filter(({ entry, ancestry: value }) => value.root === canonicalSessionId || entry.meta.session_id === canonicalSessionId);
  const associated = associatedEntries.map(({ entry }) => entry);
  const warnings = [];
  if (selectedAncestry.warning) warnings.push(selectedAncestry.warning);
  for (const { entry, ancestry: value } of associatedEntries) {
    if (entry.meta.relationship_warning) warnings.push(entry.meta.relationship_warning);
    if (value.warning) warnings.push(value.warning);
  }
  const parsed = [];

  for (const entry of associated) {
    const transcript = await parseTranscript(entry.path);
    parsed.push(transcript);
    warnings.push(...transcript.warnings);
  }

  if (!roots.length) warnings.push({ code: "transcript_roots_unavailable", message: "No canonical Codex transcript root is available." });
  else if (!associated.length) warnings.push({ code: "session_not_found", message: "No transcript was found for this explicit session id." });

  const agents = parsed.map(buildAgent).sort(agentOrder);
  const history = agents.flatMap((agent) => agent.turns.map((turn) => ({
    ...turn,
    thread_id: agent.thread_id,
    role: agent.role,
    parent_thread_id: agent.parent_thread_id,
  }))).sort((left, right) => (left.started_at ?? "").localeCompare(right.started_at ?? ""));
  const latest = [...history].sort((left, right) => (right.started_at ?? "").localeCompare(left.started_at ?? ""))[0] ?? null;
  const active = agents.flatMap((agent) => agent.turns.at(-1)?.state === "active" ? [agent.turns.at(-1)] : []);
  const requestedWorkers = parsed.flatMap((transcript) => transcript.requestedWorkers);
  const hasPartialCoverage = warnings.length > 0;

  return {
    schema_version: STATUS_SCHEMA_VERSION,
    snapshot_at: new Date(options.now?.() ?? Date.now()).toISOString(),
    session: {
      id: canonicalSessionId,
      state: active.length ? "active" : latest?.state === "native_turn_completed" ? "native_turn_completed" : "unknown",
      thread_count: agents.length,
      active_turn_count: active.length,
    },
    current: currentSnapshot(agents, latest),
    agents,
    requested_workers: requestedWorkers,
    history,
    coverage: {
      state: !associated.length ? "unavailable" : hasPartialCoverage ? "partial" : "complete",
      transcript_count: associated.length,
      warnings: uniqueWarnings(warnings),
    },
  };
}

export async function listSessions(options = {}) {
  const roots = await transcriptRoots(options);
  const catalog = await readCatalog(roots);
  const byId = new Map(catalog.map((entry) => [entry.meta.id, entry.meta]));
  const sessions = new Map();
  for (const entry of catalog) {
    const id = ancestry(entry.meta.id, byId).root;
    if (!ID_PATTERN.test(id ?? "")) continue;
    const existing = sessions.get(id) ?? { session_id: id, started_at: null, updated_at: null, thread_count: 0 };
    existing.thread_count += 1;
    existing.started_at = earliest(existing.started_at, entry.meta.timestamp);
    existing.updated_at = latest(existing.updated_at, entry.timestamp);
    sessions.set(id, existing);
  }
  return [...sessions.values()].sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""));
}

export function formatStatus(status) {
  const lines = [
    `Mallo activity — ${status.session.id}`,
    `Native state: ${status.session.state}; coverage: ${status.coverage.state}`,
  ];
  if (!status.agents.length) lines.push("No associated native transcript was found.");
  for (const agent of status.agents) {
    const turn = agent.turns.at(-1);
    const model = turn?.model?.value ?? "unknown";
    const effort = turn?.effort?.value ?? "unknown";
    lines.push(`${agent.role === "main" ? "Main" : "Worker"} ${shortId(agent.thread_id)}: ${model}/${effort}; ${turn?.state ?? "unknown"}`);
    if (turn?.current_tool) lines.push(`  Current tool: ${turn.current_tool.name} (${turn.current_tool.status})`);
    lines.push(`  Skills: ${formatSkills(turn?.skills)}`);
  }
  if (status.history.length) {
    lines.push("Native turn history:");
    for (const turn of status.history) {
      const tools = turn.tool_summary.total ? `, tools ${turn.tool_summary.completed}/${turn.tool_summary.total} completed` : "";
      lines.push(`  ${turn.role} ${shortId(turn.turn_id)}: ${turn.state}${tools}`);
    }
  }
  for (const warning of status.coverage.warnings) lines.push(`Coverage warning: ${warning.message}`);
  lines.push("Labels describe native transcript evidence; turn completion does not prove goal success or verification.");
  return lines.join("\n");
}

export function formatStatusLine(status) {
  const main = status.agents.find((agent) => agent.role === "main")?.turns.at(-1);
  const workers = status.agents.filter((agent) => agent.role === "worker").map((agent) => agent.turns.at(-1)).filter(Boolean);
  const workerModels = [...new Set(workers.map((turn) => `${turn.model?.value ?? "unknown"}/${turn.effort?.value ?? "unknown"}`))];
  const skills = [...new Set(status.agents.flatMap((agent) => agent.turns.at(-1)?.skills.items.map((item) => item.name).filter(isVisibleSkillName) ?? []))];
  const state = status.session.state === "active" ? "In progress" : status.session.state === "native_turn_completed" ? "Response completed" : "State unavailable";
  const parts = [
    `Mallo · ${state}`,
    `main ${main?.model?.value ?? "unknown"}/${main?.effort?.value ?? "unknown"}`,
  ];
  if (workers.length) parts.push(`workers ${workers.length} (${workerModels.join(", ")})`);
  if (status.current?.current_tool) parts.push(`Tool ${status.current.current_tool.name}`);
  parts.push(skills.length ? `Skill reads ${skills.join(", ")}` : status.coverage.state === "complete" ? "No skill read observed" : "Skill coverage incomplete");
  return parts.join(" · ");
}

export function isVisibleSkillName(name) {
  return typeof name === "string" && !SELF_SKILLS.has(name.toLowerCase());
}

async function transcriptRoots(options) {
  const configured = options.transcriptRoots ?? envRoots() ?? defaultRoots(options.codexHome);
  const roots = [];
  for (const root of configured) {
    try {
      const canonical = await realpath(resolve(root));
      if (!roots.includes(canonical)) roots.push(canonical);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return roots;
}

function envRoots() {
  if (!process.env.MALLO_TRANSCRIPT_ROOTS) return null;
  return process.env.MALLO_TRANSCRIPT_ROOTS.split(delimiter).filter(Boolean);
}

function defaultRoots(codexHome) {
  const home = resolve(codexHome ?? process.env.CODEX_HOME ?? resolve(homedir(), ".codex"));
  return [resolve(home, "sessions"), resolve(home, "archived_sessions")];
}

async function readCatalog(roots) {
  const entries = [];
  for (const root of roots) {
    for await (const path of jsonlFiles(root)) {
      const safePath = await canonicalChild(root, path);
      if (!safePath) continue;
      const header = await readHeader(safePath);
      if (header) entries.push({ path: safePath, ...header });
    }
  }
  return entries;
}

async function* jsonlFiles(directory) {
  let handle;
  try { handle = await opendir(directory); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for await (const entry of handle) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* jsonlFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

async function canonicalChild(root, path) {
  try {
    const canonical = await realpath(path);
    const child = relative(root, canonical);
    return child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child) ? canonical : null;
  } catch { return null; }
}

async function readHeader(path) {
  const info = await stat(path);
  const cached = headerCache.get(path);
  if (cached?.mtimeMs === info.mtimeMs && cached?.size === info.size) return cached.value;
  const handle = await open(path, "r");
  let first = "";
  let offset = 0;
  try {
    while (!first.includes("\n") && offset < Math.min(info.size, 4 * 1024 * 1024)) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, info.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      first += buffer.subarray(0, bytesRead).toString("utf8");
      offset += bytesRead;
    }
  } finally { await handle.close(); }
  first = first.split(/\r?\n/, 1)[0];
  let value = null;
  try {
    const record = JSON.parse(first);
    if (record.type !== "session_meta" || !ID_PATTERN.test(record.payload?.id ?? "")) return null;
    const meta = record.payload;
    const relationship = nativeRelationship(meta, basename(path));
    value = {
      meta: {
        id: meta.id,
        session_id: ID_PATTERN.test(meta.session_id ?? "") ? meta.session_id : meta.id,
        parent_thread_id: relationship.parent,
        relationship_warning: relationship.warning,
        timestamp: iso(meta.timestamp),
        agent_nickname: safeLabel(meta.agent_nickname ?? meta.source?.subagent?.thread_spawn?.agent_nickname),
        task_label: nativeTaskLabel(meta.agent_path ?? meta.source?.subagent?.thread_spawn?.agent_path),
      },
      timestamp: info.mtime.toISOString(),
    };
  } catch { value = null; }
  headerCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, value });
  return value;
}

async function parseTranscript(path) {
  const previous = transcriptLocks.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => parseTranscriptLocked(path));
  transcriptLocks.set(path, current);
  try { return await current; }
  finally { if (transcriptLocks.get(path) === current) transcriptLocks.delete(path); }
}

async function parseTranscriptLocked(path) {
  const info = await stat(path);
  let state = transcriptCache.get(path);
  if (!state || info.size < state.offset) {
    state = {
      info: null,
      offset: 0,
      line: 0,
      transcript: { file: basename(path), meta: null, turns: new Map(), calls: new Map(), requestedWorkers: [], warnings: [] },
    };
  }
  if (state.info?.mtimeMs === info.mtimeMs && state.info?.size === info.size) return withTailWarning(state, info.size);
  if (info.size > state.offset) {
    const handle = await open(path, "r");
    const buffer = Buffer.alloc(info.size - state.offset);
    let bytesRead;
    try { ({ bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset)); }
    finally { await handle.close(); }
    const data = buffer.subarray(0, bytesRead);
    let start = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 10) continue;
      const bytes = data.subarray(start, index);
      state.line += 1;
      consumeLine(state.transcript, bytes.toString("utf8").replace(/\r$/, ""), state.line);
      start = index + 1;
    }
    state.offset += start;
  }
  state.info = { mtimeMs: info.mtimeMs, size: info.size };
  transcriptCache.set(path, state);
  return withTailWarning(state, info.size);
}

function consumeLine(transcript, line, number) {
  if (!line) return;
  try { consumeRecord(transcript, JSON.parse(line), number); }
  catch {
    transcript.warnings.push({ code: "malformed_record", message: `${transcript.file} has an unreadable record at line ${number}.`, evidence: evidence(transcript.file, number) });
  }
}

function withTailWarning(state, size) {
  const warning = size > state.offset ? [{ code: "partial_tail", message: `${state.transcript.file} has an unreadable partial tail.`, evidence: evidence(state.transcript.file, state.line + 1) }] : [];
  return { ...state.transcript, warnings: [...state.transcript.warnings, ...warning] };
}

function consumeRecord(transcript, record, line) {
  const payload = record.payload ?? {};
  const at = iso(record.timestamp ?? payload.timestamp ?? payload.started_at ?? payload.completed_at);
  if (record.type === "session_meta") {
    const relationship = nativeRelationship(payload, transcript.file);
    transcript.meta = {
      id: payload.id,
      session_id: ID_PATTERN.test(payload.session_id ?? "") ? payload.session_id : payload.id,
      parent_thread_id: relationship.parent,
      agent_nickname: safeLabel(payload.agent_nickname ?? payload.source?.subagent?.thread_spawn?.agent_nickname),
      task_label: nativeTaskLabel(payload.agent_path ?? payload.source?.subagent?.thread_spawn?.agent_path),
      timestamp: iso(payload.timestamp ?? record.timestamp),
      evidence: evidence(transcript.file, line),
    };
    return;
  }
  if (record.type === "turn_context" && ID_PATTERN.test(payload.turn_id ?? "")) {
    const turn = ensureTurn(transcript, payload.turn_id);
    turn.model = observed(payload.model, "turn_context", transcript.file, line);
    turn.effort = observed(payload.effort, "turn_context", transcript.file, line);
    turn.contextEvidence = evidence(transcript.file, line);
    return;
  }
  if (record.type === "event_msg" && ID_PATTERN.test(payload.turn_id ?? "")) {
    const turn = ensureTurn(transcript, payload.turn_id);
    if (payload.type === "task_started") {
      turn.started_at = iso(payload.started_at ?? at) ?? turn.started_at;
      turn.state = "active";
      turn.startedEvidence = evidence(transcript.file, line);
    } else if (payload.type === "task_complete") {
      turn.completed_at = iso(payload.completed_at ?? at);
      turn.duration_ms = finiteNumber(payload.duration_ms);
      turn.state = "native_turn_completed";
      turn.completedEvidence = evidence(transcript.file, line);
    }
    return;
  }
  if (record.type !== "response_item") return;
  if (["function_call", "custom_tool_call"].includes(payload.type)) consumeToolCall(transcript, payload, line, at);
  if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) consumeToolOutput(transcript, payload, line, at);
}

function consumeToolCall(transcript, payload, line, at) {
  const name = safeToolName(payload.name);
  const callId = safeCallId(payload.call_id ?? payload.id);
  const normalized = normalizeToolName(name);
  const rawArgs = payload.arguments ?? payload.input;
  if (!name || !callId || MALLO_TOOLS.has(name) || MALLO_TOOLS.has(normalized)) return;
  const turn = latestTurn(transcript);
  if (!turn) return;
  const args = parseArguments(rawArgs);
  const call = {
    key: callId, name, status: explicitFailed(payload) ? "failed" : payload.status === "completed" ? "completed" : "running",
    started_at: at, completed_at: payload.status === "completed" ? at : null, evidence: evidence(transcript.file, line),
  };
  transcript.calls.set(callId, { turnId: turn.turn_id, call });
  turn.tools.push(call);
  for (const skill of skillReads(normalized, args, rawArgs)) {
    turn.skillReads.push({ name: skill, label: "skill reference in a read request observed; successful use is not proven", evidence: evidence(transcript.file, line) });
  }
  if (normalized === "spawn_agent") {
    transcript.requestedWorkers.push({
      requesting_thread_id: transcript.meta?.id ?? null,
      task_name: safeLabel(args?.task_name),
      requested_model: safeLabel(args?.model),
      requested_effort: safeLabel(args?.reasoning_effort),
      label: "delegation arguments requested; execution not confirmed by this record",
      evidence: evidence(transcript.file, line),
    });
  }
}

function consumeToolOutput(transcript, payload, line, at) {
  const call = transcript.calls.get(safeCallId(payload.call_id ?? payload.id));
  if (!call) return;
  call.call.status = explicitFailed(payload.output) ? "failed" : "completed";
  call.call.completed_at = at;
  call.call.completion_evidence = evidence(transcript.file, line);
}

function buildAgent(transcript) {
  const meta = transcript.meta ?? {};
  const turns = [...transcript.turns.values()].map((turn) => finalizeTurn(turn, transcript.warnings)).sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
  for (const turn of turns.slice(0, -1)) if (turn.state === "active") turn.state = "interrupted_or_unknown";
  return {
    thread_id: meta.id,
    role: meta.parent_thread_id ? "worker" : "main",
    parent_thread_id: meta.parent_thread_id ?? null,
    nickname: meta.agent_nickname ?? null,
    task_label: meta.task_label ?? null,
    relationship_evidence: meta.evidence ?? null,
    state: turns.at(-1)?.state ?? "unknown",
    turns,
  };
}

function finalizeTurn(turn, warnings) {
  const tools = turn.tools.map(({ key: _key, ...tool }) => tool);
  const skills = uniqueSkills(turn.skillReads);
  const partial = warnings.length > 0;
  return {
    turn_id: turn.turn_id,
    state: turn.state,
    started_at: turn.started_at,
    completed_at: turn.completed_at,
    duration_ms: turn.duration_ms,
    model: turn.model,
    effort: turn.effort,
    current_tool: tools.findLast((tool) => tool.status === "running") ?? null,
    tools,
    tool_summary: {
      total: tools.length,
      running: tools.filter((tool) => tool.status === "running").length,
      completed: tools.filter((tool) => tool.status === "completed").length,
      failed: tools.filter((tool) => tool.status === "failed").length,
      label: "tool lifecycle observed; completion is not task verification",
    },
    skills: {
      state: skills.length ? "read_evidence_observed" : partial ? "coverage_unavailable" : "no_read_observed",
      label: skills.length ? "Skill references in read requests were observed; successful reading or application is not proven." : partial ? "No skill reference is shown because transcript coverage is partial." : "No skill read request was observed; preloaded or unrecorded use remains possible.",
      items: skills,
    },
    evidence: {
      started: turn.startedEvidence,
      completed: turn.completedEvidence,
      model_effort: turn.contextEvidence,
    },
  };
}

function currentSnapshot(agents, latest) {
  const activeTurns = agents.flatMap((agent) => agent.turns.at(-1)?.state === "active" ? [{ agent, turn: agent.turns.at(-1) }] : []);
  const current = activeTurns.sort((a, b) => (b.turn.started_at ?? "").localeCompare(a.turn.started_at ?? ""))[0];
  if (!current) return latest ? {
    thread_id: latest.thread_id,
    turn_id: latest.turn_id,
    role: latest.role,
    state: latest.state,
    model: latest.model,
    effort: latest.effort,
    current_tool: null,
    skills: latest.skills,
  } : null;
  return {
    thread_id: current.agent.thread_id,
    turn_id: current.turn.turn_id,
    role: current.agent.role,
    state: current.turn.state,
    model: current.turn.model,
    effort: current.turn.effort,
    current_tool: current.turn.current_tool,
    skills: current.turn.skills,
  };
}

function ensureTurn(transcript, id) {
  if (!transcript.turns.has(id)) transcript.turns.set(id, {
    turn_id: id, state: "unknown", started_at: null, completed_at: null, duration_ms: null,
    model: null, effort: null, tools: [], skillReads: [],
  });
  return transcript.turns.get(id);
}

function latestTurn(transcript) {
  return [...transcript.turns.values()].at(-1) ?? null;
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || value.length > 1_000_000) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function skillReads(tool, args, rawArgs) {
  if (tool === "read_mcp_resource" && typeof args?.uri === "string" && /SKILL\.md$/i.test(args.uri)) return skillNames(args.uri);
  let commands = [];
  if (tool === "exec_command") commands = [commandText(args)];
  else if (tool === "exec" && typeof rawArgs === "string") commands = extractExecCommands(rawArgs);
  return [...new Set(commands.flatMap(skillReadsFromCommand))];
}

function commandText(value, depth = 0) {
  if (depth > 3 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => commandText(item, depth + 1)).join(" ");
  if (typeof value === "object") return Object.entries(value).filter(([key]) => /^(cmd|command|code|input)$/i.test(key)).map(([, item]) => commandText(item, depth + 1)).join(" ");
  return "";
}

function skillNames(text) {
  const normalized = text.replaceAll("\\", "/");
  const matches = [...normalized.matchAll(/(?:^|[\s'"`])([^\s'"`]+?)\/SKILL\.md\b/gi)];
  return matches.map((match) => safeLabel(match[1].split("/").filter(Boolean).at(-1))).filter(Boolean);
}

function skillReadsFromCommand(command) {
  if (!command) return [];
  const cleaned = stripPowerShellHereStrings(command);
  const arrays = new Map();
  for (const match of cleaned.matchAll(/\$(\w+)\s*=\s*@\(([\s\S]*?)\)\s*;/g)) arrays.set(match[1].toLowerCase(), skillNames(match[2]));
  const skills = [];
  for (const segment of cleaned.split(/\r?\n|;|&&|\|\|/)) {
    if (!/^\s*(?:\$\w+\s*=\s*)?(?:&\s*)?(?:Get-Content|gc|cat|type|more|sed)\b/i.test(segment)) continue;
    skills.push(...skillNames(segment));
    for (const variable of segment.matchAll(/\$(\w+)(?:\[(\d+)\])?/g)) {
      const values = arrays.get(variable[1].toLowerCase());
      if (!values) continue;
      const index = variable[2] == null ? null : Number(variable[2]);
      skills.push(...(index == null ? values : values[index] ? [values[index]] : []));
    }
  }
  return [...new Set(skills)];
}

function stripPowerShellHereStrings(command) {
  return command.replace(/@'\r?\n[\s\S]*?\r?\n'@/g, "").replace(/@"\r?\n[\s\S]*?\r?\n"@/g, "");
}

function extractExecCommands(script) {
  const commands = [];
  for (let index = 0; index < script.length;) {
    const skipped = skipJsLiteral(script, index);
    if (skipped > index) { index = skipped; continue; }
    if (!script.startsWith("tools.exec_command", index)) { index += 1; continue; }
    let openIndex = index + "tools.exec_command".length;
    while (/\s/.test(script[openIndex] ?? "")) openIndex += 1;
    if (script[openIndex] !== "(") { index += 1; continue; }
    const closeIndex = matchingParen(script, openIndex);
    if (closeIndex < 0) break;
    const argument = script.slice(openIndex + 1, closeIndex).trim();
    let command = "";
    try {
      const parsed = JSON.parse(argument);
      command = commandText(parsed);
    } catch { command = jsObjectCommand(argument); }
    if (command) commands.push(command);
    index = closeIndex + 1;
  }
  return commands;
}

function jsObjectCommand(argument) {
  if (!argument.trimStart().startsWith("{")) return "";
  for (let index = 0; index < argument.length;) {
    const skipped = skipJsLiteral(argument, index);
    if (skipped > index) { index = skipped; continue; }
    const match = /^(?:cmd|command)\s*:\s*/.exec(argument.slice(index));
    if (!match) { index += 1; continue; }
    const literal = readJsString(argument, index + match[0].length);
    return literal?.value ?? "";
  }
  return "";
}

function readJsString(source, index) {
  const quote = source[index];
  if (!["'", '"', "`"].includes(quote)) return null;
  let value = "";
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === quote) return { value, end: cursor + 1 };
    if (quote === "`" && character === "$" && source[cursor + 1] === "{") return null;
    if (character !== "\\") { value += character; continue; }
    const escaped = source[++cursor];
    if (escaped == null) return null;
    const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
    value += simple[escaped] ?? escaped;
  }
  return null;
}

function matchingParen(script, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < script.length; index += 1) {
    const skipped = skipJsLiteral(script, index);
    if (skipped > index) { index = skipped - 1; continue; }
    if (script[index] === "(") depth += 1;
    else if (script[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function skipJsLiteral(script, index) {
  const quote = script[index];
  if (["'", '"', "`"].includes(quote)) {
    for (let cursor = index + 1; cursor < script.length; cursor += 1) {
      if (script[cursor] === "\\") cursor += 1;
      else if (script[cursor] === quote) return cursor + 1;
    }
    return script.length;
  }
  if (script.startsWith("//", index)) {
    const end = script.indexOf("\n", index + 2);
    return end < 0 ? script.length : end + 1;
  }
  if (script.startsWith("/*", index)) {
    const end = script.indexOf("*/", index + 2);
    return end < 0 ? script.length : end + 2;
  }
  return index;
}

function explicitFailed(value) {
  if (typeof value === "string") {
    try { return explicitFailed(JSON.parse(value)); } catch { return false; }
  }
  if (!value || typeof value !== "object") return false;
  if (value.isError === true || value.success === false || (Number.isInteger(value.exit_code) && value.exit_code !== 0)) return true;
  if (["failed", "error", "cancelled"].includes(String(value.status ?? "").toLowerCase())) return true;
  return Array.isArray(value) && value.some(explicitFailed);
}

function observed(value, source, file, line) {
  const label = safeLabel(value);
  return label ? { value: label, label: `observed ${source}`, evidence: evidence(file, line) } : null;
}

function evidence(file, line) { return { source: "native_transcript", file, line }; }
function safeToolName(value) { return typeof value === "string" && /^[\w:.-]{1,160}$/.test(value) ? value : null; }
function safeCallId(value) { return typeof value === "string" && value.length <= 200 ? value : null; }
function safeLabel(value) { return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : null; }
function nativeTaskLabel(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  return safeLabel(value.split(/[\\/]/).filter(Boolean).at(-1));
}
function finiteNumber(value) { return Number.isFinite(value) && value >= 0 ? value : null; }
function iso(value) {
  const normalized = typeof value === "number" && Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  const date = normalized == null ? null : new Date(normalized);
  return date && !Number.isNaN(date.valueOf()) ? date.toISOString() : null;
}
function earliest(left, right) { return !left ? right : !right ? left : left < right ? left : right; }
function latest(left, right) { return !left ? right : !right ? left : left > right ? left : right; }
function shortId(value) { return value ? value.slice(-8) : "unknown"; }
function assertId(value, label) { if (!ID_PATTERN.test(value ?? "")) throw new Error(`Invalid ${label}`); }
function uniqueSkills(items) { return [...new Map(items.map((item) => [item.name, item])).values()]; }
function uniqueWarnings(items) { return [...new Map(items.map((item) => [`${item.code}:${item.evidence?.file ?? ""}:${item.evidence?.line ?? ""}`, item])).values()]; }
function agentOrder(left, right) { return left.role === right.role ? (left.thread_id ?? "").localeCompare(right.thread_id ?? "") : left.role === "main" ? -1 : 1; }
function formatSkills(skills) {
  const visible = skills?.items?.map((item) => item.name).filter(isVisibleSkillName) ?? [];
  return visible.length ? `${visible.join(", ")} (read evidence only)` : skills?.state === "coverage_unavailable" ? "coverage unavailable" : "no read observed";
}

function normalizeToolName(name) {
  if (!name) return null;
  if (name.startsWith("mcp__")) return name;
  return name.split(/[.:]/).at(-1);
}

function nativeRelationship(meta, file) {
  const candidate = meta.parent_thread_id ?? meta.source?.subagent?.thread_spawn?.parent_thread_id;
  if (candidate == null) return { parent: null, warning: null };
  if (ID_PATTERN.test(candidate)) return { parent: candidate, warning: null };
  return { parent: null, warning: { code: "invalid_parent_thread_id", message: `${file} has an invalid native parent thread id.` } };
}

function ancestry(id, byId) {
  let current = id;
  const seen = new Set();
  while (ID_PATTERN.test(current ?? "") && !seen.has(current)) {
    seen.add(current);
    const meta = byId.get(current);
    if (!meta?.parent_thread_id) return { root: meta?.session_id && byId.has(meta.session_id) ? meta.session_id : current, warning: null };
    if (!byId.has(meta.parent_thread_id)) return {
      root: meta.session_id && byId.has(meta.session_id) ? meta.session_id : current,
      warning: { code: "missing_parent_transcript", message: `${meta.id} references a parent transcript that is unavailable.` },
    };
    current = meta.parent_thread_id;
  }
  return { root: id, warning: { code: "parent_cycle", message: `${id} has a cyclic native parent relationship.` } };
}
