#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnose, findExecutable, redactForEvidence } from "./doctor.mjs";
import { AppServerClient } from "./codex.mjs";
import { ProjectRegistry } from "./bindings.mjs";
import { readYaml } from "./contracts.mjs";
import { runManagedTask } from "./runner.mjs";
import { installIntegration, uninstallIntegration } from "./install.mjs";
import { applyFeedback, finalizeRun, rebuildBrain, searchBrain } from "./brain.mjs";
import { buildResumeContext, publishControl, readRunState, reconcileResumeState } from "./control.mjs";
import { exportBackup, importBackup } from "./backup.mjs";
import { discoverSkills, selectSkills } from "./catalog.mjs";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

function usage() {
  return "Usage: codex-system doctor [--json] [--write-evidence [path]]\n       codex-system install|uninstall\n       codex-system register --project <path>\n       codex-system run --request-file <path>\n       codex-system status|cancel|resume --run-id <id>\n       codex-system respond --run-id <id> --request-id <id> --file <path>\n       codex-system feedback --run-id <id> --file <path>\n       codex-system brain finalize --run-id <id>\n       codex-system brain search --file <path>\n       codex-system brain rebuild [--project-id <id>]\n       codex-system skills inspect --project <path> [--stage <stage>] [--file <task.json>]\n       codex-system backup export --destination <path>\n       codex-system backup import --source <path> [--project-map <json>]\n       codex-system hook-context --cwd <path>\n       codex-system smoke dispatch [--write-evidence [path]]";
}

async function doctor(args) {
  const report = await diagnose({ cwd: process.cwd(), codexPath: option(args, "--codex") });
  const evidenceIndex = args.indexOf("--write-evidence");
  if (evidenceIndex !== -1) {
    const requested = args[evidenceIndex + 1];
    const evidencePath = requested && !requested.startsWith("--")
      ? resolve(requested)
      : resolve(sourceRoot, ".local", "implementation-evidence", "M0", "capabilities.json");
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(redactForEvidence(report), null, 2)}\n`, { encoding: "utf8", flag: "w" });
    report.evidencePath = evidencePath;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.requiredCapabilitiesReady) process.exitCode = 2;
}

async function smokeDispatch(args) {
  const capabilities = await diagnose({ cwd: process.cwd(), codexPath: option(args, "--codex") });
  if (!capabilities.requiredCapabilitiesReady) throw new Error(`Required capabilities are unavailable: ${capabilities.blockers.join("; ")}`);
  const schema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ok"] },
      observed_file: { type: "string" },
    },
    required: ["status", "observed_file"],
    additionalProperties: false,
  };
  const probes = [
    { model: "gpt-5.6-sol", effort: "medium" },
    { model: "gpt-6-astra", effort: "high" },
  ];
  const client = new AppServerClient({ codexPath: capabilities.codex.path, cwd: process.cwd(), timeoutMs: 30_000 });
  const results = [];
  try {
    await client.start();
    for (const probe of probes) {
      const thread = await client.startThread({ ...probe, cwd: process.cwd() });
      const result = await client.runTurn({
        threadId: thread.thread.id,
        input: "Read README.md only. Return status=ok and observed_file=README.md. Do not call tools except the minimum read needed, and do not modify files.",
        model: probe.model,
        effort: probe.effort,
        outputSchema: schema,
      });
      let parsed;
      try { parsed = JSON.parse(result.finalText); }
      catch { throw new Error(`${probe.model} did not return valid structured JSON`); }
      if (parsed.status !== "ok" || parsed.observed_file !== "README.md") throw new Error(`${probe.model} returned an unexpected probe result`);
      results.push({
        ...probe,
        threadModel: thread.model,
        threadInitialReasoningEffort: thread.reasoningEffort,
        threadId: result.threadId,
        turnId: result.turnId,
        turnStatus: result.turn.status,
        output: parsed,
        reroutes: result.metadata.reroutes,
      });
    }
    const cancellationThread = await client.startThread({ model: "gpt-5.6-sol", cwd: process.cwd() });
    try {
      await client.runTurn({
        threadId: cancellationThread.thread.id,
        input: "Wait before answering so the client can exercise cancellation. Do not modify files.",
        model: "gpt-5.6-sol",
        effort: "medium",
        outputSchema: schema,
        onTurnStarted: ({ threadId, turnId }) => client.interrupt(threadId, turnId),
      });
      throw new Error("Cancellation probe unexpectedly completed");
    } catch (error) {
      const status = error.details?.turn?.status ?? null;
      if (status !== "interrupted") throw error;
      reportCancellation(results, cancellationThread.thread.id, error.details.turn.id, status);
    }
  } finally {
    await client.close();
  }
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), cwd: process.cwd(), results };
  const evidenceIndex = args.indexOf("--write-evidence");
  if (evidenceIndex !== -1) {
    const requested = args[evidenceIndex + 1];
    const evidencePath = requested && !requested.startsWith("--")
      ? resolve(requested)
      : resolve(sourceRoot, ".local", "implementation-evidence", "M1", "dispatch.json");
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.evidencePath = evidencePath;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function reportCancellation(results, threadId, turnId, status) {
  results.push({ probe: "cancellation", model: "gpt-5.6-sol", threadId, turnId, turnStatus: status });
}

async function register(args) {
  const project = option(args, "--project");
  if (!project) throw new Error("register requires --project");
  const registry = new ProjectRegistry({ hubRoot: sourceRoot });
  process.stdout.write(`${JSON.stringify(await registry.register(resolve(project)), null, 2)}\n`);
}

async function runTask(args) {
  const requestFile = option(args, "--request-file");
  if (!requestFile) throw new Error("run requires --request-file");
  const result = await runManagedTask({
    hubRoot: sourceRoot,
    requestFile,
    onProgress: (progress) => process.stderr.write(`${JSON.stringify({ type: "progress", ...progress })}\n`),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.outcome.status !== "completed") process.exitCode = 3;
}

async function status(args) {
  const runId = option(args, "--run-id");
  if (!runId || !/^run-[0-9a-f-]+$/i.test(runId)) throw new Error("status requires a valid --run-id");
  const index = await readYaml(resolve(sourceRoot, ".local", "run-index", `${runId}.yaml`));
  const state = await readYaml(resolve(index.run_root, "state.yaml"));
  let outcome = null;
  try { outcome = await readYaml(resolve(index.run_root, "outcome.yaml")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  process.stdout.write(`${JSON.stringify({ index, state, outcome }, null, 2)}\n`);
}

async function hookContext(args) {
  if (process.env.CODEX_SYSTEM_MANAGED_RUN === "1") return;
  const cwd = option(args, "--cwd");
  if (!cwd) return;
  const registry = new ProjectRegistry({ hubRoot: sourceRoot });
  try {
    const binding = await registry.resolve(cwd);
    process.stdout.write(JSON.stringify({
      systemMessage: "CODEX_SYSTEM:AVAILABLE",
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `Codex System is installed for registered project ${binding.projectId} at the current cwd. Use the codex-system skill for project implementation, fixes, planning, or verification. Skip it for informational questions. Never select a sibling project.`,
      },
    }));
  } catch {
    // Out-of-scope sessions stay inactive.
  }
}

async function brain(args) {
  const action = args.shift();
  if (action === "finalize") {
    const runId = option(args, "--run-id");
    if (!runId) throw new Error("brain finalize requires --run-id");
    process.stdout.write(`${JSON.stringify(await finalizeRun({ hubRoot: sourceRoot, runId }), null, 2)}\n`);
  } else if (action === "search") {
    const file = option(args, "--file");
    if (!file) throw new Error("brain search requires --file");
    const input = JSON.parse(await readFile(resolve(file), "utf8"));
    process.stdout.write(`${JSON.stringify(await searchBrain({ hubRoot: sourceRoot, input }), null, 2)}\n`);
  } else if (action === "rebuild") {
    process.stdout.write(`${JSON.stringify(await rebuildBrain({ hubRoot: sourceRoot, projectId: option(args, "--project-id") }), null, 2)}\n`);
  } else throw new Error("brain requires finalize, search, or rebuild");
}

async function cancel(args) {
  const runId = option(args, "--run-id");
  process.stdout.write(`${JSON.stringify(await publishControl({ hubRoot: sourceRoot, runId, type: "cancel" }), null, 2)}\n`);
}

async function respond(args) {
  const runId = option(args, "--run-id");
  const requestId = option(args, "--request-id");
  const file = option(args, "--file");
  if (!file) throw new Error("respond requires --file");
  const payload = JSON.parse(await readFile(resolve(file), "utf8"));
  process.stdout.write(`${JSON.stringify(await publishControl({ hubRoot: sourceRoot, runId, type: "respond", requestId, payload }), null, 2)}\n`);
}

async function resume(args) {
  const runId = option(args, "--run-id");
  const { index, state } = await readRunState(sourceRoot, runId);
  const reconciliation = reconcileResumeState(state);
  if (reconciliation.action === "terminal") return status(["--run-id", runId]);
  const revisedFile = option(args, "--file");
  if (reconciliation.action === "blocked" || (reconciliation.action === "needs_revision" && !revisedFile)) {
    process.stdout.write(`${JSON.stringify({ runId, ...reconciliation }, null, 2)}\n`);
    process.exitCode = 3;
    return;
  }
  if (isPidAlive(state.controller?.pid)) throw new Error(`Run controller is still active: ${state.controller.pid}`);
  const task = await readYaml(resolve(index.run_root, "task.yaml"));
  const revised = revisedFile ? JSON.parse(await readFile(resolve(revisedFile), "utf8")) : null;
  if (revised && (typeof revised.request !== "string" || !revised.request.trim())) throw new Error("resume --file requires a non-empty request");
  const requestPath = resolve(sourceRoot, ".local", "resume", `${runId}.json`);
  await mkdir(dirname(requestPath), { recursive: true });
  await writeFile(requestPath, `${JSON.stringify({ schema_version: 1, request: revised?.request ?? task.request, original_request: revised?.original_request ?? task.original_request ?? task.request, cwd: task.cwd, scope: task.scope, exclusions: task.exclusions, explicit_skills: revised?.explicit_skills ?? task.explicit_skills ?? [], resumed_from: runId, resume_context: buildResumeContext(state) }, null, 2)}\n`, "utf8");
  const result = await runManagedTask({ hubRoot: sourceRoot, requestFile: requestPath, onProgress: (progress) => process.stderr.write(`${JSON.stringify({ type: "progress", resumedFrom: runId, ...progress })}\n`) });
  process.stdout.write(`${JSON.stringify({ resumedFrom: runId, ...result }, null, 2)}\n`);
}

async function feedback(args) {
  const runId = option(args, "--run-id");
  const file = option(args, "--file");
  if (!file) throw new Error("feedback requires --file");
  const input = JSON.parse(await readFile(resolve(file), "utf8"));
  process.stdout.write(`${JSON.stringify(await applyFeedback({ hubRoot: sourceRoot, runId, feedback: input }), null, 2)}\n`);
}

async function backup(args) {
  const action = args.shift();
  if (action === "export") {
    const destination = option(args, "--destination");
    if (!destination) throw new Error("backup export requires --destination");
    process.stdout.write(`${JSON.stringify(await exportBackup({ hubRoot: sourceRoot, destination }), null, 2)}\n`);
  } else if (action === "import") {
    const source = option(args, "--source");
    if (!source) throw new Error("backup import requires --source");
    const mapFile = option(args, "--project-map");
    const projectRoots = mapFile ? JSON.parse(await readFile(resolve(mapFile), "utf8")) : {};
    process.stdout.write(`${JSON.stringify(await importBackup({ hubRoot: sourceRoot, source, projectRoots }), null, 2)}\n`);
  } else throw new Error("backup requires export or import");
}

async function skills(args) {
  const action = args.shift();
  if (action !== "inspect") throw new Error("skills requires inspect");
  const project = option(args, "--project");
  if (!project) throw new Error("skills inspect requires --project");
  const binding = await new ProjectRegistry({ hubRoot: sourceRoot }).resolve(resolve(project));
  const taskFile = option(args, "--file");
  const task = taskFile ? JSON.parse(await readFile(resolve(taskFile), "utf8")) : { request: "" };
  const stage = option(args, "--stage") ?? "implementation";
  if (!["triage", "plan", "implementation", "repair", "review"].includes(stage)) throw new Error(`Unsupported skill stage: ${stage}`);
  const codexPath = await findExecutable("codex", process.env.CODEX_SYSTEM_CODEX_PATH);
  if (!codexPath) throw new Error("Codex executable is unavailable");
  const client = new AppServerClient({ codexPath, cwd: binding.cwd, timeoutMs: 30_000 });
  try {
    await client.start();
    const configPath = resolve(sourceRoot, "config", "skills.yaml");
    const catalog = await discoverSkills({ client, cwd: binding.cwd, configPath });
    const selected = await selectSkills({ client, cwd: binding.cwd, stage, configPath, task, catalog });
    process.stdout.write(`${JSON.stringify({ schema_version: 1, project_id: binding.projectId, cwd: binding.cwd, stage, catalog_revision: catalog.revision, available: catalog.skills.length, discovery_errors: catalog.errors, selected, excluded: selected.excluded.slice(0, 50) }, null, 2)}\n`);
  } finally { await client.close(); }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

const args = process.argv.slice(2);
const command = args.shift();
if (command === "doctor") await doctor(args);
else if (command === "install") process.stdout.write(`${JSON.stringify(await installIntegration(sourceRoot), null, 2)}\n`);
else if (command === "uninstall") process.stdout.write(`${JSON.stringify(await uninstallIntegration(sourceRoot), null, 2)}\n`);
else if (command === "smoke" && args.shift() === "dispatch") await smokeDispatch(args);
else if (command === "register") await register(args);
else if (command === "run") await runTask(args);
else if (command === "status") await status(args);
else if (command === "cancel") await cancel(args);
else if (command === "respond") await respond(args);
else if (command === "resume") await resume(args);
else if (command === "feedback") await feedback(args);
else if (command === "backup") await backup(args);
else if (command === "brain") await brain(args);
else if (command === "skills") await skills(args);
else if (command === "hook-context") await hookContext(args);
else {
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
}
