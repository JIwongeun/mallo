#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatStatus, formatStatusLine, getStatus, listSessions } from "./lib/activity.mjs";
import { currentActivity } from "./lib/observe.mjs";

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  if (command === "sessions") {
    validateFlags(flags, ["json"]);
    return print(flags.json ? await listSessions() : formatSessions(await listSessions()), flags.json);
  }
  if (!["status", "watch"].includes(command)) throw new Error("Usage: mallo <status|watch> --session <id> [--json]");
  validateFlags(flags, command === "status" ? ["session", "json", "view", "phase", "turn", "focus-task", "format"] : ["session", "json", "interval"]);
  const sessionId = requiredFlag(flags, "session");
  if (command === "status" && flags.view === "current") {
    if ("format" in flags && !["plain", "markdown"].includes(flags.format)) throw new Error("--format must be plain or markdown");
    const snapshot = await currentActivity({ session_id: sessionId, phase: requiredFlag(flags, "phase"), turn_id: flags.turn, focus_task: flags["focus-task"] });
    return print(flags.json ? snapshot : flags.format === "markdown" ? snapshot.markdown : snapshot.line, flags.json);
  }
  if (command === "status") {
    if (flags.view !== undefined || flags.phase !== undefined || flags.turn !== undefined || flags["focus-task"] !== undefined || "format" in flags) throw new Error("--phase, --turn, --focus-task, and --format require --view current");
    return print(flags.json ? await getStatus(sessionId) : formatStatus(await getStatus(sessionId)), flags.json);
  }
  return watch(sessionId, flags);
}

async function watch(sessionId, flags) {
  let previous = "";
  for (;;) {
    const status = await getStatus(sessionId);
    const rendered = flags.json ? JSON.stringify(status) : formatStatusLine(status);
    const comparable = flags.json ? JSON.stringify({ ...status, snapshot_at: undefined }) : rendered;
    if (comparable !== previous) {
      process.stdout.write(`${rendered}\n`);
      previous = comparable;
    }
    const interval = numericFlag(flags.interval, status.session.state === "active" ? 1000 : 5000);
    await new Promise((accept) => setTimeout(accept, interval));
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name.startsWith("--")) throw new Error(`Unexpected argument: ${name}`);
    const key = name.slice(2);
    if (key === "json") flags.json = true;
    else flags[key] = rest[++index];
  }
  return { command, flags };
}

function requiredFlag(flags, name) {
  if (typeof flags[name] !== "string" || !flags[name]) throw new Error(`--${name} is required`);
  return flags[name];
}

function validateFlags(flags, allowed) {
  const unexpected = Object.keys(flags).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Unexpected argument: --${unexpected}`);
}

function numericFlag(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > 2_147_483_647) throw new Error("Expected a positive integer no larger than the JavaScript timer limit");
  return number;
}

function formatSessions(sessions) {
  if (!sessions.length) return "No native Codex sessions found.";
  return sessions.map((session) => `${session.session_id}  ${session.thread_count} thread(s)  ${session.updated_at ?? "unknown"}`).join("\n");
}

function print(value, json) { process.stdout.write(`${json ? JSON.stringify(value, null, 2) : value}\n`); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
