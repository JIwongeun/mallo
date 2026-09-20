import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;

export class AppServerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AppServerError";
    this.details = details;
  }
}

export class AppServerClient extends EventEmitter {
  constructor({ codexPath, cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
    super();
    if (!codexPath) throw new TypeError("codexPath is required");
    this.codexPath = codexPath;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.env = env;
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
    this.stderr = "";
    this.initialized = false;
    this.threadUsageTotals = new Map();
  }

  async start() {
    if (this.process) return this;
    const child = spawn(this.codexPath, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_384);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.on("error", (error) => this.failAll(new AppServerError("Failed to start Codex App Server", { cause: error.message })));
    child.on("exit", (code, signal) => {
      this.process = null;
      if (this.pending.size) {
        this.failAll(new AppServerError("Codex App Server exited with pending requests", {
          code,
          signal,
          stderr: this.stderr,
        }));
      }
      this.emit("exit", { code, signal });
    });

    const response = await this.request("initialize", {
      clientInfo: { name: "relay", title: "Relay", version: "0.2.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify("initialized");
    this.initialized = true;
    return response;
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit("protocolError", new AppServerError("App Server emitted invalid JSON", {
        line: line.slice(0, 1_000),
        cause: error.message,
      }));
      return;
    }

    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) {
        this.emit("protocolError", new AppServerError("Received a response for an unknown request", { id: message.id }));
        return;
      }
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new AppServerError(message.error.message ?? "App Server request failed", message.error));
      else pending.resolve(message.result);
      return;
    }

    if (message.method && Object.hasOwn(message, "id")) {
      this.emit("serverRequest", message);
      return;
    }
    if (message.method) this.emit("notification", message);
    else this.emit("protocolError", new AppServerError("Received an unrecognized App Server message", { message }));
  }

  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.process?.stdin?.writable) return Promise.reject(new AppServerError("App Server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new AppServerError(`App Server request timed out: ${method}`, { id, timeoutMs }));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer, method });
      this.write({ method, id, params });
    });
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  respondError(id, code, message, data) {
    this.write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  write(message) {
    if (!this.process?.stdin?.writable) throw new AppServerError("App Server stdin is not writable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async listModels({ includeHidden = true } = {}) {
    const models = [];
    let cursor = null;
    do {
      const response = await this.request("model/list", { cursor, limit: 100, includeHidden });
      models.push(...(response?.data ?? []));
      cursor = response?.nextCursor ?? null;
    } while (cursor);
    return models;
  }

  async listSkills(cwd, forceReload = false) {
    return (await this.request("skills/list", { cwds: [cwd], forceReload }))?.data ?? [];
  }

  async listHooks(cwd) {
    return (await this.request("hooks/list", { cwds: [cwd] }))?.data ?? [];
  }

  async listMcpServers(threadId) {
    const servers = [];
    let cursor = null;
    do {
      const result = await this.request("mcpServerStatus/list", { cursor, limit: 100, detail: "toolsAndAuthOnly", ...(threadId ? { threadId } : {}) });
      servers.push(...(result.data ?? []));
      cursor = result.nextCursor ?? null;
    } while (cursor);
    return servers;
  }

  async startThread({ model, cwd = this.cwd, approvalPolicy = "never", sandbox = "read-only", ephemeral = true } = {}) {
    return this.request("thread/start", {
      model,
      allowProviderModelFallback: false,
      cwd,
      approvalPolicy,
      sandbox,
      ephemeral,
      serviceName: "codex-system",
    });
  }

  async resumeThread({ threadId, model, cwd = this.cwd, approvalPolicy = "never", sandbox = "read-only" } = {}) {
    if (!threadId) throw new TypeError("threadId is required");
    return this.request("thread/resume", {
      threadId,
      model,
      cwd,
      approvalPolicy,
      sandbox,
      excludeTurns: true,
    });
  }

  async runTurn({
    threadId,
    input,
    model,
    effort,
    cwd = this.cwd,
    outputSchema,
    skills = [],
    approvalPolicy = "never",
    sandboxPolicy = { type: "readOnly", networkAccess: false },
    onServerRequest,
    onTurnStarted,
    timeoutMs = 300_000,
  }) {
    if (!threadId) throw new TypeError("threadId is required");
    if (!input) throw new TypeError("input is required");
    const items = [];
    const metadata = { requestedModel: model, requestedEffort: effort, reroutes: [], usage: [] };
    const usageBaseline = this.threadUsageTotals.get(threadId) ?? {};

    let terminalResolve;
    let terminalReject;
    let activeTurnId = null;
    const terminal = new Promise((resolve, reject) => {
      terminalResolve = resolve;
      terminalReject = reject;
    });
    // A server can disconnect before turn/start replies; attach immediately.
    terminal.catch(() => {});
    const timer = setTimeout(() => terminalReject(new AppServerError("Codex turn timed out", { threadId, activeTurnId, timeoutMs })), timeoutMs);

    const notificationListener = (message) => {
      const params = message.params ?? {};
      if (params.threadId && params.threadId !== threadId) return;
      if (activeTurnId && params.turnId && params.turnId !== activeTurnId) return;
      if (message.method === "item/completed" && params.item) items.push(params.item);
      if (message.method === "model/rerouted") metadata.reroutes.push(params);
      if (/tokenUsage/i.test(message.method)) {
        metadata.usage = [params];
        const totals = params.tokenUsage?.total;
        if (totals) {
          metadata.usageDelta = Object.fromEntries(Object.entries(totals).filter(([, value]) => typeof value === "number").map(([key, value]) => [key, Math.max(0, value - (usageBaseline[key] ?? 0))]));
          this.threadUsageTotals.set(threadId, totals);
        }
      }
      if (message.method === "turn/completed" && (!activeTurnId || params.turn?.id === activeTurnId)) terminalResolve(params.turn);
      if (message.method === "error" && !params.willRetry && (!params.threadId || params.threadId === threadId)) {
        terminalReject(new AppServerError(params.error?.message ?? params.message ?? "Codex turn failed", params));
      }
    };
    const exitListener = (details) => terminalReject(new AppServerError("Codex App Server disconnected during turn", details));
    const protocolListener = (error) => terminalReject(error);
    const requestListener = async (message) => {
      if (message.params?.threadId && message.params.threadId !== threadId) return;
      try {
        if (!onServerRequest) {
          this.respond(message.id, defaultServerRequestResponse(message.method));
          return;
        }
        const result = await onServerRequest(message);
        this.respond(message.id, result);
      } catch (error) {
        this.respondError(message.id, -32_000, error.message);
      }
    };
    this.on("notification", notificationListener);
    this.on("serverRequest", requestListener);
    this.on("exit", exitListener);
    this.on("protocolError", protocolListener);
    try {
      const started = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input, text_elements: [] }, ...skills.map(({ name, path }) => ({ type: "skill", name, path }))],
        cwd,
        approvalPolicy,
        sandboxPolicy,
        model,
        effort,
        outputSchema,
      }, { timeoutMs: Math.min(timeoutMs, this.timeoutMs) });
      activeTurnId = started.turn.id;
      if (onTurnStarted) await onTurnStarted({ threadId, turnId: activeTurnId });
      const turn = await terminal;
      if (turn.status !== "completed") {
        throw new AppServerError(`Codex turn ended with status ${turn.status}`, { threadId, turn });
      }
      const completedItems = turn.items?.length ? turn.items : items;
      const messages = completedItems.filter((item) => item.type === "agentMessage");
      const final = [...messages].reverse().find((item) => item.phase === "final_answer") ?? messages.at(-1) ?? null;
      return { threadId, turnId: turn.id, turn, items: completedItems, finalText: final?.text ?? null, metadata };
    } catch (error) {
      if (activeTurnId && this.process) await this.interrupt(threadId, activeTurnId).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      this.off("notification", notificationListener);
      this.off("serverRequest", requestListener);
      this.off("exit", exitListener);
      this.off("protocolError", protocolListener);
    }
  }

  interrupt(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  executeCommand({ argv, cwd, env, timeoutMs, sandboxPolicy, processId }) {
    return this.request("command/exec", { command: argv, cwd, env, timeoutMs, sandboxPolicy, processId, ...(process.platform === "win32" ? {} : { outputBytesCap: 100_000 }) }, { timeoutMs: timeoutMs + 10_000 });
  }

  terminateCommand(processId) {
    return this.request("command/exec/terminate", { processId });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    const child = this.process;
    if (!child) return;
    this.process = null;
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000, stdio: "ignore" });
      else child.kill();
    }
    this.emit("exit", { reason: "client closed" });
    this.failAll(new AppServerError("Codex App Server client closed"));
  }
}

export function evaluateRequiredModels(models) {
  const required = {
    "gpt-6-astra": ["medium", "high", "xhigh"],
    "gpt-5.6-sol": ["medium", "high", "xhigh"],
  };
  const byName = new Map();
  for (const model of models) {
    byName.set(model.model, model);
    byName.set(model.id, model);
  }
  const report = {};
  for (const [name, efforts] of Object.entries(required)) {
    const model = byName.get(name);
    const availableEfforts = (model?.supportedReasoningEfforts ?? []).map((entry) => entry.reasoningEffort ?? entry.effort ?? entry);
    report[name] = {
      available: Boolean(model),
      displayName: model?.displayName ?? null,
      availableEfforts,
      requiredEfforts: efforts,
      missingEfforts: efforts.filter((effort) => !availableEfforts.includes(effort)),
    };
  }
  return report;
}

export function defaultServerRequestResponse(method) {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (method === "item/tool/requestUserInput") return { answers: {} };
  throw new AppServerError(`Unsupported server request without a handler: ${method}`);
}
