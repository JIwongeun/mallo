import { DatabaseSync } from "node:sqlite";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { AppServerClient, evaluateRequiredModels } from "./codex.mjs";

function executableCandidates(name) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return paths.flatMap((folder) => suffixes.map((suffix) => `${folder}/${name}${suffix}`));
}

export async function findExecutable(name, override) {
  const candidates = override ? [override] : executableCandidates(name);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    error: result.error?.message ?? null,
  };
}

export function checkSqlite() {
  const database = new DatabaseSync(":memory:");
  try {
    const version = database.prepare("select sqlite_version() version").get().version;
    database.exec("create virtual table probe using fts5(content)");
    database.exec("insert into probe(content) values ('codex system')");
    const fts5 = database.prepare("select count(*) count from probe where probe match 'codex'").get().count === 1;
    return { ok: fts5, version, fts5 };
  } finally {
    database.close();
  }
}

export async function diagnose({ cwd = process.cwd(), codexPath: override } = {}) {
  const codexPath = await findExecutable("codex", override ?? process.env.CODEX_SYSTEM_CODEX_PATH);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    cwd,
    platform: process.platform,
    node: { version: process.version, executable: process.execPath },
    sqlite: checkSqlite(),
    codex: { path: codexPath, version: null, authenticated: false, doctorStatus: null },
    appServer: { initialized: false, models: {}, skillsReadable: false, hooksReadable: false },
    requiredCapabilitiesReady: false,
    blockers: [],
  };
  if (!codexPath) {
    report.blockers.push("Codex executable was not found. Set CODEX_SYSTEM_CODEX_PATH or fix PATH.");
    return report;
  }

  const version = run(codexPath, ["--version"], cwd);
  report.codex.version = version.ok ? version.stdout : null;
  const auth = run(codexPath, ["login", "status"], cwd);
  report.codex.authenticated = auth.ok && /logged in/i.test(`${auth.stdout} ${auth.stderr}`);
  if (!report.codex.authenticated) report.blockers.push("Codex ChatGPT authentication is unavailable.");
  const nativeDoctor = run(codexPath, ["doctor", "--json"], cwd);
  try {
    report.codex.doctorStatus = nativeDoctor.ok ? JSON.parse(nativeDoctor.stdout).overallStatus : "failed";
  } catch {
    report.codex.doctorStatus = "invalid-output";
  }

  const client = new AppServerClient({ codexPath, cwd });
  try {
    const initialized = await client.start();
    report.appServer.initialized = true;
    report.appServer.server = {
      userAgent: initialized.userAgent,
      codexHome: initialized.codexHome,
      platformFamily: initialized.platformFamily,
      platformOs: initialized.platformOs,
    };
    const [models, skills, hooks] = await Promise.all([
      client.listModels(),
      client.listSkills(cwd),
      client.listHooks(cwd),
    ]);
    report.appServer.models = evaluateRequiredModels(models);
    report.appServer.skillsReadable = Array.isArray(skills);
    report.appServer.hooksReadable = Array.isArray(hooks);
  } catch (error) {
    report.blockers.push(`Codex App Server discovery failed: ${error.message}`);
  } finally {
    await client.close();
  }

  for (const [name, model] of Object.entries(report.appServer.models)) {
    if (!model.available) report.blockers.push(`Required model is unavailable on this host: ${name}`);
    else if (model.missingEfforts.length) report.blockers.push(`Required reasoning efforts are unavailable for ${name}: ${model.missingEfforts.join(", ")}`);
  }
  if (!report.sqlite.ok) report.blockers.push("Node built-in SQLite FTS5 is unavailable.");
  if (!report.appServer.skillsReadable) report.blockers.push("Native skill discovery is unavailable.");
  if (!report.appServer.hooksReadable) report.blockers.push("Native hook discovery is unavailable.");
  report.requiredCapabilitiesReady = report.blockers.length === 0;
  return report;
}

export function redactForEvidence(report) {
  return {
    ...report,
    cwd: report.cwd,
    node: { ...report.node, executable: dirname(report.node.executable) },
  };
}
