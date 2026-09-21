import { createInterface } from "node:readline";
import { formatStatus, getStatus, listSessions } from "./lib/activity.mjs";
import { currentActivity, observeActivity } from "./lib/observe.mjs";

const VERSION = "0.3.2";
const observerMemory = new Map();
const tools = [
  {
    name: "show_activity",
    title: "Show activity",
    description: "Read native Codex activity for one explicit session id. Set view=current for a compact exact-thread checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Explicit native Codex session or thread UUID." },
        view: { type: "string", enum: ["current"] },
        phase: { type: "string", enum: ["progress", "summary"] },
        turn_id: { type: "string", description: "Optional exact native turn UUID." },
        focus_task: { type: "string", minLength: 1, maxLength: 160, description: "Progress-only native task label to display; use main for the coordinator." },
        task_labels: {
          type: "object",
          description: "Short grounded English task names keyed by main or an exact native worker task label. Non-English or invalid display strings fall back.",
          maxProperties: 32,
          additionalProperties: { type: "string" },
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    annotations: { title: "Show activity", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "task_summary",
    title: "Task summary",
    description: "Read the final whole-task native activity summary for one explicit session id.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Explicit native Codex session or thread UUID." },
        turn_id: { type: "string", description: "Optional exact native turn UUID." },
        task_labels: {
          type: "object",
          description: "Short grounded English task names keyed by main or an exact native worker task label. Non-English or invalid display strings fall back.",
          maxProperties: 32,
          additionalProperties: { type: "string" },
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    annotations: { title: "Task summary", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_activity",
    title: "List Mallo sessions",
    description: "List native Codex session ids with transcript activity. Use an id with show_activity.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List Mallo sessions", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "observe_activity",
    title: "Observe native Mallo activity",
    description: "Hook-only read of the current native turn. Returns a changed one-line system message or an empty object.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        turn_id: { type: "string" },
        hook_event_name: { type: "string", enum: ["UserPromptSubmit", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "Interrupt"] },
        model: { type: "string" },
        agent_id: { type: "string" }
      },
      required: ["session_id", "turn_id", "hook_event_name"],
      additionalProperties: false
    },
    annotations: { title: "Observe native Mallo activity", readOnlyHint: true, openWorldHint: false },
  },
];

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch { return sendError(null, -32700, "Parse error"); }
  void handle(message);
});

async function handle(message) {
  if (!(message && typeof message === "object") || !("id" in message)) return;
  try {
    if (message.method === "initialize") return send(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2026-01-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "mallo", title: "Mallo", version: VERSION },
    });
    if (message.method === "ping") return send(message.id, {});
    if (message.method === "tools/list") return send(message.id, { tools });
    if (message.method === "tools/call") return send(message.id, await callTool(message.params));
    return sendError(message.id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    send(message.id, { content: [{ type: "text", text: error.message }], isError: true });
  }
}

async function callTool(params) {
  const args = params?.arguments ?? {};
  if (params?.name === "observe_activity") {
    let output = {};
    try { output = await observeActivity(args, observerMemory); } catch { /* Hooks fail open. */ }
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
  }
  if (params?.name === "show_activity") {
    if (typeof args.session_id !== "string") throw new Error("show_activity requires session_id");
    if (args.view === "current") {
      const snapshot = await currentActivity(args);
      return { content: [{ type: "text", text: snapshot.text }] };
    }
    if (Object.keys(args).some((key) => key !== "session_id")) throw new Error("show_activity options require view=current");
    const status = await getStatus(args.session_id);
    return {
      content: [{ type: "text", text: formatStatus(status) }],
      structuredContent: status,
    };
  }
  if (params?.name === "task_summary") {
    if (typeof args.session_id !== "string") throw new Error("task_summary requires session_id");
    if (Object.keys(args).some((key) => !["session_id", "turn_id", "task_labels"].includes(key))) throw new Error("task_summary accepts only session_id, turn_id, and task_labels");
    const snapshot = await currentActivity({ ...args, phase: "summary" });
    return { content: [{ type: "text", text: snapshot.text }] };
  }
  if (params?.name === "list_activity") {
    if (Object.keys(args).length) throw new Error("list_activity accepts no arguments");
    const sessions = await listSessions();
    return {
      content: [{ type: "text", text: sessions.length ? sessions.map((item) => `${item.session_id} (${item.thread_count} thread(s))`).join("\n") : "No native Codex sessions found." }],
      structuredContent: { schema_version: 1, sessions },
    };
  }
  throw new Error(`Unknown tool: ${params?.name}`);
}

function send(id, result) { sendRaw({ jsonrpc: "2.0", id, result }); }
function sendError(id, code, message) { sendRaw({ jsonrpc: "2.0", id, error: { code, message } }); }
function sendRaw(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
