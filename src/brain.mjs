import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { isWithin, ProjectRegistry } from "./bindings.mjs";
import { readYaml, writeYamlAtomic } from "./contracts.mjs";
import { acquireOwnedLock, assertMaintenanceInactive, releaseOwnedLock } from "./locks.mjs";

const SEARCH_STOP_WORDS = new Set(["and", "build", "change", "code", "concrete", "create", "existing", "file", "files", "for", "from", "implementation", "improve", "plan", "planning", "project", "request", "review", "test", "tests", "the", "this", "use", "with"]);

export async function finalizeRun({ hubRoot, runId }) {
  const index = await readYaml(resolve(hubRoot, ".local", "run-index", `${runId}.yaml`));
  const outcome = await readYaml(resolve(index.run_root, "outcome.yaml"));
  if (!["completed", "failed"].includes(outcome.status) || outcome.planning_only) return { run_id: runId, finalized: true, patterns: [], reason: "no assessed execution evidence" };
  const candidates = await readCandidates(index.run_root);
  if (candidates.length === 0) return { run_id: runId, finalized: true, patterns: [], reason: "no learning candidates" };
  const checks = await readLatestChecks(index.run_root);
  const verdict = outcome.status === "completed" ? "pass" : "fail";
  const applicableChecks = checks.filter((check) => check.status === (verdict === "pass" ? "passed" : "failed"));
  if (applicableChecks.length === 0) return { run_id: runId, finalized: true, patterns: [], reason: "no applicable execution checks" };
  const registry = new ProjectRegistry({ hubRoot });
  const binding = await registry.resolve(index.project_root);
  const patterns = [];
  for (const candidate of candidates) {
    // A candidate must name an assessed criterion; unrelated passing checks are not support.
    const supported = (outcome.criteria ?? []).filter((criterion) => candidate.criterion_ids?.includes(criterion.id) && criterion.verdict === verdict && criterion.basis === "execution");
    const supportedChecks = applicableChecks.filter((check) => supported.some((criterion) => criterion.evidence_refs?.includes(`check:${check.id}`)));
    if (supportedChecks.length === 0) continue;
    patterns.push(await mergeCandidate({
      hubRoot,
      binding,
      candidate,
      evidence: {
        project_id: binding.projectId,
        run_id: runId,
        stage: "verify",
        artifact_revision: outcome.final_artifact_revision,
        review_revision: outcome.review_revision,
        outcome: verdict,
        basis: "execution",
        check_ids: supportedChecks.map((check) => check.id),
        criterion_ids: supported.map((criterion) => criterion.id),
        source_run_root: index.run_root,
      },
    }));
  }
  return { run_id: runId, finalized: true, patterns };
}

export async function mergeCandidate({ hubRoot, binding, candidate, evidence, expectedRevision = null }) {
  validateCandidate(candidate);
  await validateEvidence(evidence, binding);
  const scope = candidate.scope === "shared" ? "shared" : "project";
  const store = scope === "shared" ? resolve(hubRoot, "brain") : resolve(binding.projectRoot, ".codex-system");
  await assertMaintenanceInactive(hubRoot);
  const lock = await acquireStoreLock(store);
  try {
    await assertMaintenanceInactive(hubRoot);
    const id = patternId(candidate, scope === "project" ? binding.projectId : "shared");
    const path = resolve(store, "patterns", `${id}.yaml`);
    let current = null;
    try { current = await readYaml(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (expectedRevision !== null && (current?.revision ?? 0) !== expectedRevision) throw new Error(`Pattern revision conflict for ${id}`);
    const evidenceKey = canonicalEvidence(evidence);
    const evidenceList = current?.evidence ?? [];
    const duplicate = evidenceList.some((entry) => canonicalEvidence(entry) === evidenceKey);
    const candidateRelations = await resolveRelations({ hubRoot, binding, candidate, evidence, currentId: id });
    const relations = new Map((current?.relations ?? []).map((relation) => [`${relation.type}\0${relation.target_id}`, relation]));
    for (const relation of candidateRelations) {
      const key = `${relation.type}\0${relation.target_id}`;
      const existing = relations.get(key);
      relations.set(key, existing ? { ...relation, evidence_refs: uniqueEvidenceRefs([...(existing.evidence_refs ?? []), ...relation.evidence_refs]) } : relation);
    }
    const mergedRelations = [...relations.values()];
    const relationsChanged = JSON.stringify(current?.relations ?? []) !== JSON.stringify(mergedRelations);
    const changed = !current || !duplicate || relationsChanged;
    const pattern = {
      schema_version: 1,
      id,
      revision: current ? current.revision + (changed ? 1 : 0) : 1,
      scope,
      ...(scope === "project" ? { project_id: binding.projectId } : {}),
      kind: evidence.outcome === "fail" ? "failure_prevention" : current?.kind ?? "success_pattern",
      stages: ["plan", "implement", "verify"],
      tags: normalizedTags(candidate.tags),
      status: current?.status === "needs_revalidation" ? current.status : evidence.outcome === "fail" ? "provisional" : evidenceStatus(duplicate ? evidenceList : [...evidenceList, evidence]),
      applies_when: candidate.applies_when.trim(),
      recommended: candidate.recommended.trim(),
      avoid: candidate.avoid.trim(),
      evidence: duplicate ? evidenceList : [...evidenceList, evidence],
      relations: mergedRelations,
      assessments: current?.assessments ?? [],
      updated_at: new Date().toISOString(),
    };
    if (changed) await writeYamlAtomic(path, pattern);
    await rebuildStore(store);
    return { id, revision: pattern.revision, scope, duplicate };
  } finally {
    await releaseStoreLock(lock);
  }
}

export async function searchBrain({ hubRoot, input }) {
  validateSearchInput(input);
  const registry = new ProjectRegistry({ hubRoot });
  const registryData = await registry.load();
  const matches = registryData.projects.filter((entry) => entry.project_id === input.project_id);
  const project = input.project_root
    ? matches.find((entry) => resolve(entry.root).toLowerCase() === resolve(input.project_root).toLowerCase())
    : matches.length === 1 ? matches[0] : null;
  if (!project && matches.length > 1 && !input.project_root) throw new Error(`project_root is required for worktree project_id: ${input.project_id}`);
  if (!project) throw new Error(`Unknown project_id: ${input.project_id}`);
  const stores = [resolve(project.root, ".codex-system"), resolve(hubRoot, "brain")];
  const tokens = searchTokens(input);
  const candidates = [];
  for (const store of stores) {
    await rebuildStore(store);
    candidates.push(...queryStore(store, tokens, input));
  }
  const unique = new Map();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.id);
    if (!existing || candidate.score > existing.score) unique.set(candidate.id, candidate);
  }
  let selected = [...unique.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 3);
  const related = await relatedCard(stores, selected, input);
  if (related && !selected.some((card) => card.id === related.id)) selected = [...selected.slice(0, 2), related];
  return { schema_version: 1, cards: selected.map(({ score, source_path, evidence_available, relation_reason, ...card }) => ({ ...card, evidence_level: evidence_available ? card.status : "source_unavailable", retrieval_reason: relation_reason ?? (score > 10 ? "exact or tag match" : "keyword match"), source_ref: source_path })) };
}

export async function rebuildBrain({ hubRoot, projectId = null }) {
  const stores = [resolve(hubRoot, "brain")];
  if (projectId) {
    const registry = await new ProjectRegistry({ hubRoot }).load();
    const projects = registry.projects.filter((entry) => entry.project_id === projectId);
    if (projects.length === 0) throw new Error(`Unknown project_id: ${projectId}`);
    stores.unshift(...projects.map((project) => resolve(project.root, ".codex-system")));
  }
  const results = [];
  for (const store of stores) results.push(await rebuildStore(store));
  return results;
}

export async function applyFeedback({ hubRoot, runId, feedback }) {
  if (feedback?.schema_version !== 1 || !["accepted", "rejected"].includes(feedback.verdict) || typeof feedback.text !== "string" || !feedback.text.trim()) throw new Error("Feedback requires schema_version=1, accepted/rejected verdict, and text");
  const index = await readYaml(resolve(hubRoot, ".local", "run-index", `${runId}.yaml`));
  await assertMaintenanceInactive(hubRoot);
  const runLock = await acquireOwnedLock(resolve(hubRoot, ".local", "locks", `feedback-${hash(runId).slice(0, 16)}.lock`), { run_id: runId, operation: "feedback" }, `Feedback is already active for ${runId}`);
  try {
  await assertMaintenanceInactive(hubRoot);
  const outcomePath = resolve(index.run_root, "outcome.yaml");
  const outcome = await readYaml(outcomePath);
  const knownCriteria = new Set((outcome.criteria ?? []).map((criterion) => criterion.id));
  const criterionIds = [...new Set(feedback.criterion_ids ?? [])];
  for (const id of criterionIds) if (!knownCriteria.has(id)) throw new Error(`Feedback references unknown criterion: ${id}`);
  const feedbackRoot = resolve(index.run_root, "feedback");
  await mkdir(feedbackRoot, { recursive: true });
  const revision = (await readdir(feedbackRoot)).filter((name) => /^\d+\.yaml$/.test(name)).length + 1;
  await writeYamlAtomic(resolve(feedbackRoot, `${revision}.yaml`), { schema_version: 1, revision, run_id: runId, verdict: feedback.verdict, text: feedback.text, criterion_ids: criterionIds, unassigned: criterionIds.length === 0, created_at: new Date().toISOString() });
  const revisionsRoot = resolve(index.run_root, "outcome-revisions");
  try { await access(resolve(revisionsRoot, "1.yaml")); }
  catch { await writeYamlAtomic(resolve(revisionsRoot, "1.yaml"), { ...outcome, assessment_revision: 1 }); }
  const revisedCriteria = (outcome.criteria ?? []).map((criterion) => criterionIds.length === 0 || criterionIds.includes(criterion.id)
    ? { ...criterion, user_feedback: feedback.verdict, feedback_revision: revision }
    : criterion);
  const assessmentRevision = (outcome.assessment_revision ?? 1) + 1;
  const revised = { ...outcome, criteria: revisedCriteria, assessment_revision: assessmentRevision, user_acceptance: criterionIds.length ? outcome.user_acceptance : feedback.verdict, feedback_revision: revision };
  await writeYamlAtomic(resolve(revisionsRoot, `${assessmentRevision}.yaml`), revised);
  await writeYamlAtomic(outcomePath, revised);

  const registry = await new ProjectRegistry({ hubRoot }).load();
  const project = registry.projects.find((entry) => entry.project_id === index.project_id && resolve(entry.root).toLowerCase() === resolve(index.project_root).toLowerCase());
  const stores = [resolve(hubRoot, "brain"), ...(project ? [resolve(project.root, ".codex-system")] : [])];
  const affected = [];
  for (const store of stores) {
    const lock = await acquireStoreLock(store);
    try {
      const root = resolve(store, "patterns");
      await mkdir(root, { recursive: true });
      for (const name of (await readdir(root)).filter((item) => item.endsWith(".yaml"))) {
        const path = resolve(root, name);
        const pattern = await readYaml(path);
        const linked = (pattern.evidence ?? []).filter((entry) => entry.run_id === runId);
        if (linked.length === 0) continue;
        if (criterionIds.length && !linked.some((entry) => entry.criterion_ids?.some((id) => criterionIds.includes(id)))) continue;
        const nextStatus = feedback.verdict === "rejected" ? "needs_revalidation" : await evidenceAvailable(pattern) ? evidenceStatus(pattern.evidence) : "needs_revalidation";
        const next = { ...pattern, revision: pattern.revision + 1, status: nextStatus, assessments: [...(pattern.assessments ?? []), { feedback_revision: revision, verdict: feedback.verdict, text: feedback.text, criterion_ids: criterionIds, unassigned: criterionIds.length === 0 }], updated_at: new Date().toISOString() };
        await writeYamlAtomic(path, next);
        affected.push({ id: next.id, revision: next.revision, status: next.status });
      }
      await rebuildStore(store);
    } finally { await releaseStoreLock(lock); }
  }
  return { run_id: runId, feedback_revision: revision, user_acceptance: revised.user_acceptance, affected_patterns: affected };
  } finally { await releaseStoreLock(runLock); }
}

async function rebuildStore(store) {
  await mkdir(resolve(store, "patterns"), { recursive: true });
  const paths = (await readdir(resolve(store, "patterns"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => resolve(store, "patterns", entry.name)).sort();
  const patterns = [];
  for (const path of paths) {
    const pattern = await readYaml(path);
    validatePattern(pattern);
    patterns.push({ pattern, path, hash: hash(await readFile(path)), evidenceAvailable: await evidenceAvailable(pattern) });
  }
  const dbPath = resolve(store, "index.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    const fingerprint = hash(JSON.stringify([2, patterns.map(({ path, hash, evidenceAvailable }) => [path, hash, evidenceAvailable])]));
    if (db.prepare("SELECT value FROM meta WHERE key='fingerprint'").get()?.value === fingerprint) return { store, patterns: patterns.length, index: dbPath, unchanged: true };
    // ponytail: scan source hashes on lookup; incremental filesystem tracking only if this becomes slow.
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec("DROP TABLE IF EXISTS patterns; DROP TABLE IF EXISTS pattern_fts; CREATE TABLE patterns(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, scope TEXT NOT NULL, project_id TEXT, status TEXT NOT NULL, tags TEXT NOT NULL, applies_when TEXT NOT NULL, recommended TEXT NOT NULL, avoid_text TEXT NOT NULL, source_path TEXT NOT NULL, source_hash TEXT NOT NULL, evidence_available INTEGER NOT NULL, stages TEXT NOT NULL, environments TEXT NOT NULL); CREATE VIRTUAL TABLE pattern_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');");
      const insert = db.prepare("INSERT INTO patterns VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      const fts = db.prepare("INSERT INTO pattern_fts(id,text) VALUES(?,?)");
      for (const { pattern, path, hash: sourceHash, evidenceAvailable } of patterns) {
        const tags = (pattern.tags ?? []).join(" ");
        insert.run(pattern.id, pattern.revision, pattern.scope, pattern.project_id ?? null, pattern.status, tags, pattern.applies_when, pattern.recommended, pattern.avoid, path, sourceHash, evidenceAvailable ? 1 : 0, JSON.stringify(pattern.stages ?? []), JSON.stringify(pattern.environments ?? []));
        fts.run(pattern.id, `${tags} ${pattern.applies_when} ${pattern.recommended} ${pattern.avoid}`);
      }
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version','2')").run();
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('fingerprint',?)").run(fingerprint);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
  return { store, patterns: patterns.length, index: dbPath };
}

function queryStore(store, tokens, input) {
  const db = new DatabaseSync(resolve(store, "index.sqlite"), { readOnly: true });
  try {
    const byId = new Map();
    const applicable = "(p.scope='shared' OR p.project_id=?) AND (p.stages='[]' OR EXISTS(SELECT 1 FROM json_each(p.stages) WHERE value=?)) AND (p.environments='[]' OR EXISTS(SELECT 1 FROM json_each(p.environments) WHERE value=?))";
    const args = [input.project_id, input.stage, input.environment ?? ""];
    const explicit = input.referenced_pattern_ids ?? [];
    for (const id of explicit) {
      const row = db.prepare(`SELECT p.* FROM patterns p WHERE id=? AND status IN ('provisional','validated','needs_revalidation') AND ${applicable}`).get(id, ...args);
      if (row) byId.set(row.id, { ...row, score: 20 });
    }
    if (tokens.length) {
      const expression = tokens.map((token) => `\"${token.replaceAll('"', '""')}\"`).join(" OR ");
      for (const row of db.prepare(`SELECT p.*, bm25(pattern_fts) AS rank FROM pattern_fts JOIN patterns p USING(id) WHERE pattern_fts MATCH ? AND p.status IN ('provisional','validated','needs_revalidation') AND ${applicable} ORDER BY rank, p.id LIMIT 10`).all(expression, ...args)) {
        const score = relevanceScore(row, tokens, input.task_summary);
        if (score) byId.set(row.id, { ...row, score: Math.max(byId.get(row.id)?.score ?? 0, score) });
      }
    }
    if (byId.size < 3 && tokens.length) {
      const clauses = tokens.map(() => "instr(lower(p.tags || ' ' || p.applies_when || ' ' || p.recommended || ' ' || p.avoid_text), ?) > 0").join(" OR ");
      const rows = db.prepare(`SELECT p.* FROM patterns p WHERE status IN ('provisional','validated','needs_revalidation') AND ${applicable} AND (${clauses}) ORDER BY p.id LIMIT 50`).all(...args, ...tokens.map((token) => token.toLowerCase()));
      for (const row of rows) {
        const score = relevanceScore(row, tokens, input.task_summary);
        if (score) byId.set(row.id, { ...row, score: Math.max(byId.get(row.id)?.score ?? 0, score) });
      }
    }
    return [...byId.values()].map((row) => ({ id: row.id, revision: row.revision, scope: row.scope, status: row.status, applies_when: row.applies_when, recommended: row.recommended, avoid: row.avoid_text, evidence_available: Boolean(row.evidence_available), source_path: row.source_path, score: row.score }));
  } finally { db.close(); }
}

async function readCandidates(runRoot) {
  try { return (await readYaml(resolve(runRoot, "learning-candidates.yaml"))).candidates ?? []; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const stages = resolve(runRoot, "stages");
  const entries = await readdir(stages, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries.filter((item) => item.isDirectory() && /^(implementation|repair-)/.test(item.name))) {
    const output = await readYaml(resolve(stages, entry.name, "output.yaml"));
    candidates.push(...(output.output?.learning_candidates ?? []));
  }
  return candidates;
}

async function readLatestChecks(runRoot) {
  try { return (await readYaml(resolve(runRoot, "checks.yaml"))).checks ?? []; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const root = resolve(runRoot, "checks");
  const names = (await readdir(root)).filter((name) => name.endsWith(".yaml")).sort((a, b) => Number.parseInt(a) - Number.parseInt(b));
  return names.length ? (await readYaml(resolve(root, names.at(-1)))).checks ?? [] : [];
}

function validateCandidate(candidate) {
  for (const field of ["applies_when", "recommended", "avoid"]) if (typeof candidate?.[field] !== "string" || !candidate[field].trim()) throw new Error(`Learning candidate requires ${field}`);
  if (candidate.scope && !["project", "shared"].includes(candidate.scope)) throw new Error(`Invalid pattern scope: ${candidate.scope}`);
  if (candidate.scope === "shared" && /[A-Z]:[\\/]|\.codex-system|run-[0-9a-f-]+/i.test(JSON.stringify(candidate))) throw new Error("Shared pattern contains project-specific identifiers");
  if (candidate.relations !== undefined && !Array.isArray(candidate.relations)) throw new Error("Learning candidate relations must be an array");
}

async function validateEvidence(evidence, binding) {
  if (evidence.project_id !== binding.projectId || evidence.basis !== "execution" || !["pass", "fail"].includes(evidence.outcome) || !evidence.run_id || !evidence.check_ids?.length) throw new Error("Pattern evidence must resolve to an execution in the bound project");
  const runRoot = resolve(evidence.source_run_root ?? "");
  if (!isWithin(resolve(binding.projectRoot, ".codex-system", "runs"), runRoot)) throw new Error("Pattern evidence run path is outside the bound project");
  await access(resolve(runRoot, "outcome.yaml"));
  const outcome = await readYaml(resolve(runRoot, "outcome.yaml"));
  if ((evidence.outcome === "pass" ? outcome.status !== "completed" : outcome.status !== "failed") || outcome.planning_only) throw new Error("Pattern source outcome does not match execution evidence");
  if (outcome.run_id && outcome.run_id !== evidence.run_id) throw new Error("Pattern source run identity mismatch");
  if (outcome.final_artifact_revision && outcome.final_artifact_revision !== evidence.artifact_revision) throw new Error("Pattern artifact revision mismatch");
  const checks = await readLatestChecks(runRoot);
  const byId = new Map(checks.map((check) => [check.id, check]));
  for (const id of evidence.check_ids) if (byId.get(id)?.status !== (evidence.outcome === "pass" ? "passed" : "failed")) throw new Error(`Pattern evidence check outcome mismatch: ${id}`);
}

function validatePattern(pattern) {
  if (pattern?.schema_version !== 1 || !pattern.id || !["project", "shared"].includes(pattern.scope) || !Number.isInteger(pattern.revision) || pattern.revision < 1) throw new Error(`Invalid pattern record: ${pattern?.id ?? "unknown"}`);
  if (pattern.scope === "project" && !pattern.project_id) throw new Error(`Project pattern lacks project_id: ${pattern.id}`);
  if (!Array.isArray(pattern.evidence) || !Array.isArray(pattern.relations)) throw new Error(`Pattern lacks evidence or relations: ${pattern.id}`);
  for (const relation of pattern.relations) if (!["related_to", "refines", "contradicts", "supersedes"].includes(relation.type)) throw new Error(`Invalid relation type: ${relation.type}`);
  for (const relation of pattern.relations) {
    if (!relation.target_id || relation.target_id === pattern.id) throw new Error(`Invalid relation target in ${pattern.id}`);
    if (relation.target_revision !== undefined && (!Number.isInteger(relation.target_revision) || relation.target_revision < 1)) throw new Error(`Invalid relation revision in ${pattern.id}`);
    if (relation.target_scope !== undefined && !["project", "shared"].includes(relation.target_scope)) throw new Error(`Invalid relation scope in ${pattern.id}`);
  }
}

function validateSearchInput(input) {
  if (!input || input.schema_version !== 1 || typeof input.project_id !== "string" || typeof input.task_summary !== "string" || typeof input.stage !== "string") throw new Error("Brain search requires schema_version, project_id, task_summary, and stage");
}

function searchTokens(input) {
  const raw = [input.task_summary, ...(input.original_terms ?? []), ...(input.english_terms ?? []), ...(input.exact_errors ?? [])].join(" ");
  return [...new Set((raw.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_.:-]{2,}/gu) ?? []).map((token) => token.replace(/^[_.:-]+|[_.:-]+$/g, "")).filter((token) => token && !SEARCH_STOP_WORDS.has(token)))].slice(0, 20);
}

function relevanceScore(row, tokens, taskSummary) {
  const text = `${row.tags} ${row.applies_when} ${row.recommended} ${row.avoid_text}`.toLowerCase();
  const phrase = String(taskSummary ?? "").normalize("NFKC").trim().toLowerCase();
  if (phrase.length >= 4 && text.includes(phrase)) return 15;
  const tags = new Set(String(row.tags ?? "").toLowerCase().split(/\s+/).filter(Boolean));
  const hits = tokens.filter((token) => text.includes(token));
  if (hits.some((token) => tags.has(token))) return 12 + hits.length;
  return hits.length >= 2 ? hits.length : 0;
}

function patternId(candidate, scopeIdentity) {
  const slug = candidate.recommended.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 5).join("-") || "pattern";
  return `${slug.slice(0, 48)}-${hash(`${scopeIdentity}\0${candidate.applies_when}\0${candidate.recommended}\0${candidate.avoid}`).slice(0, 10)}`;
}

function normalizedTags(tags = []) {
  return [...new Set(tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 10);
}

function canonicalEvidence(evidence) {
  return [evidence.project_id, evidence.run_id, evidence.stage, evidence.artifact_revision, evidence.review_revision, evidence.outcome, evidence.basis, ...(evidence.check_ids ?? []).toSorted(), ...(evidence.criterion_ids ?? []).toSorted()].join("\0");
}

function uniqueEvidenceRefs(refs) {
  const unique = new Map();
  for (const ref of refs) unique.set(JSON.stringify([ref.run_id, ref.criterion_ids ?? [], ref.check_ids ?? []]), ref);
  return [...unique.values()];
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

function evidenceStatus(evidence) {
  if (evidence.some((entry) => entry.outcome === "fail")) return "provisional";
  return new Set(evidence.filter((entry) => entry.outcome === "pass" && entry.basis === "execution" && entry.criterion_ids?.length).map((entry) => `${entry.project_id}/${entry.run_id}`)).size >= 2 ? "validated" : "provisional";
}

async function acquireStoreLock(store) {
  const path = resolve(store, ".store.lock");
  return acquireOwnedLock(path, { operation: "brain-write" }, `Brain store is busy: ${store}`);
}

async function releaseStoreLock(lock) {
  await releaseOwnedLock(lock);
}

async function evidenceAvailable(pattern) {
  if (pattern.evidence.length === 0) return false;
  for (const evidence of pattern.evidence) {
    if (!evidence.source_run_root) return false;
    try { await access(resolve(evidence.source_run_root, "outcome.yaml")); }
    catch { return false; }
  }
  return true;
}

async function relatedCard(stores, selected, input) {
  const seen = new Set(selected.map((card) => card.id));
  const relations = [];
  for (const card of selected) {
    const pattern = await readYaml(card.source_path);
    for (const relation of pattern.relations ?? []) if (!seen.has(relation.target_id)) relations.push(relation);
  }
  relations.sort((a, b) => relationPriority(a.type) - relationPriority(b.type));
  for (const relation of relations) {
    for (const store of stores) {
      const db = new DatabaseSync(resolve(store, "index.sqlite"), { readOnly: true });
      try {
        const row = db.prepare("SELECT * FROM patterns p WHERE id=? AND status IN ('provisional','validated','needs_revalidation') AND (p.scope='shared' OR p.project_id=?) AND (p.stages='[]' OR EXISTS(SELECT 1 FROM json_each(p.stages) WHERE value=?)) AND (p.environments='[]' OR EXISTS(SELECT 1 FROM json_each(p.environments) WHERE value=?))").get(relation.target_id, input.project_id, input.stage, input.environment ?? "");
        if (row && (!relation.target_revision || relation.target_revision === row.revision) && row.evidence_available) return { id: row.id, revision: row.revision, scope: row.scope, status: row.status, applies_when: row.applies_when, recommended: row.recommended, avoid: row.avoid_text, evidence_available: true, source_path: row.source_path, score: 0, relation_reason: `one-hop ${relation.type}` };
      } finally { db.close(); }
    }
  }
  return null;
}

async function resolveRelations({ hubRoot, binding, candidate, evidence, currentId }) {
  const resolved = [];
  for (const relation of candidate.relations ?? []) {
    if (!["related_to", "refines", "contradicts", "supersedes"].includes(relation.type) || typeof relation.target_id !== "string" || !relation.target_id || relation.target_id === currentId) throw new Error("Invalid learning relation");
    const targets = [];
    for (const store of [resolve(binding.projectRoot, ".codex-system"), resolve(hubRoot, "brain")]) {
      try {
        const target = await readYaml(resolve(store, "patterns", `${relation.target_id}.yaml`));
        validatePattern(target);
        targets.push(target);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (targets.length !== 1) throw new Error(targets.length ? `Ambiguous relation target: ${relation.target_id}` : `Unknown relation target: ${relation.target_id}`);
    const target = targets[0];
    resolved.push({
      type: relation.type,
      target_id: target.id,
      target_scope: target.scope,
      target_revision: target.revision,
      assessment_revision: evidence.review_revision,
      evidence_refs: [{ run_id: evidence.run_id, criterion_ids: evidence.criterion_ids, check_ids: evidence.check_ids }],
    });
  }
  return resolved;
}

function relationPriority(type) {
  return ({ contradicts: 0, supersedes: 1, refines: 2, related_to: 3 })[type] ?? 4;
}
