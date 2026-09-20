import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";

const MAX_RECORD_BYTES = 1_000_000;

export const triageSchema = {
  type: "object",
  properties: {
    task_kind: { type: "string", enum: ["implementation", "fix", "planning", "review", "other"] },
    complexity: { type: "string", enum: ["simple", "normal", "complex"] },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    ambiguity: { type: "string", enum: ["low", "medium", "high"] },
    affected_surfaces: { type: "array", items: { type: "string" }, maxItems: 20 },
    acceptance_criteria: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false }, minItems: 1, maxItems: 20 },
    constraints: { type: "array", items: { type: "string" }, maxItems: 20 },
    evidence_refs: { type: "array", items: { type: "string" }, maxItems: 30 },
    search_terms: { type: "array", items: { type: "string" }, maxItems: 30 },
  },
  required: ["task_kind", "complexity", "risk", "ambiguity", "affected_surfaces", "acceptance_criteria", "constraints", "evidence_refs", "search_terms"],
  additionalProperties: false,
};

export const planSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    assumptions: { type: "array", items: { type: "string" }, maxItems: 20 },
    unresolved_questions: { type: "array", items: { type: "string" }, maxItems: 10 },
    work_items: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", properties: {
      id: { type: "string" }, dependencies: { type: "array", items: { type: "string" } }, files: { type: "array", items: { type: "string" } }, behavior: { type: "string" }, criterion_ids: { type: "array", items: { type: "string" } }, checks: { type: "array", items: { type: "string" } },
    }, required: ["id", "dependencies", "files", "behavior", "criterion_ids", "checks"], additionalProperties: false } },
  },
  required: ["summary", "assumptions", "unresolved_questions", "work_items"],
  additionalProperties: false,
};

export const implementationSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    work_items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["completed", "blocked", "skipped"] }, evidence: { type: "string" } }, required: ["id", "status", "evidence"], additionalProperties: false } },
    changed_files: { type: "array", items: { type: "string" }, maxItems: 100 },
    blockers: { type: "array", items: { type: "string" }, maxItems: 20 },
    learning_candidates: { type: "array", items: { type: "object", properties: {
      applies_when: { type: "string" }, recommended: { type: "string" }, avoid: { type: "string" }, scope: { type: "string", enum: ["project", "shared"] }, tags: { type: "array", items: { type: "string" }, maxItems: 10 },
      relations: { type: "array", maxItems: 5, items: { type: "object", properties: { type: { type: "string", enum: ["related_to", "refines", "contradicts", "supersedes"] }, target_id: { type: "string" } }, required: ["type", "target_id"], additionalProperties: false } },
    }, required: ["applies_when", "recommended", "avoid", "scope", "tags"], additionalProperties: false }, maxItems: 5 },
  },
  required: ["summary", "work_items", "changed_files", "blockers", "learning_candidates"],
  additionalProperties: false,
};

export const reviewSchema = {
  type: "object",
  properties: {
    recommendation: { type: "string", enum: ["accept", "repair", "replan", "needs_input", "blocked"] },
    findings: { type: "array", items: { type: "object", properties: { severity: { type: "string", enum: ["critical", "major", "minor"] }, text: { type: "string" }, evidence_ref: { type: "string" } }, required: ["severity", "text", "evidence_ref"], additionalProperties: false }, maxItems: 30 },
    criteria: { type: "array", items: { type: "object", properties: { id: { type: "string" }, verdict: { type: "string", enum: ["pass", "fail", "unknown", "not_applicable"] }, basis: { type: "string", enum: ["review", "execution"] }, evidence_refs: { type: "array", items: { type: "string" } } }, required: ["id", "verdict", "basis", "evidence_refs"], additionalProperties: false } },
  },
  required: ["recommendation", "findings", "criteria"],
  additionalProperties: false,
};

implementationSchema.properties.learning_candidates.items.properties.criterion_ids = { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } };
implementationSchema.properties.learning_candidates.items.required.push("criterion_ids");
implementationSchema.properties.learning_candidates.items.required.push("relations");

export function validateTriage(value) {
  validateSchema(value, triageSchema, "triage");
  assertObject(value, "triage");
  for (const field of triageSchema.required) if (!(field in value)) throw new Error(`Triage is missing ${field}`);
  assertEnum(value.task_kind, triageSchema.properties.task_kind.enum, "task_kind");
  assertEnum(value.complexity, triageSchema.properties.complexity.enum, "complexity");
  assertEnum(value.risk, triageSchema.properties.risk.enum, "risk");
  assertEnum(value.ambiguity, triageSchema.properties.ambiguity.enum, "ambiguity");
  if (!Array.isArray(value.acceptance_criteria) || value.acceptance_criteria.length === 0) throw new Error("Triage requires acceptance criteria");
  uniqueIds(value.acceptance_criteria, "acceptance criterion");
  for (const criterion of value.acceptance_criteria) if (typeof criterion.text !== "string" || !criterion.text.trim()) throw new Error(`Acceptance criterion ${criterion.id} requires text`);
  return value;
}

export function validatePlan(value, criterionIds) {
  validateSchema(value, planSchema, "plan");
  assertObject(value, "plan");
  if (!Array.isArray(value.work_items) || value.work_items.length === 0) throw new Error("Plan requires work items");
  uniqueIds(value.work_items, "work item");
  const ids = new Set(value.work_items.map((item) => item.id));
  for (const item of value.work_items) {
    if (!Array.isArray(item.dependencies) || !Array.isArray(item.criterion_ids) || item.criterion_ids.length === 0) throw new Error(`Work item ${item.id} requires dependencies and criterion_ids`);
    for (const dependency of item.dependencies ?? []) if (!ids.has(dependency)) throw new Error(`Unknown work-item dependency: ${dependency}`);
    for (const id of item.criterion_ids ?? []) if (!criterionIds.has(id)) throw new Error(`Unknown criterion in plan: ${id}`);
  }
  assertAcyclic(value.work_items);
  const covered = new Set(value.work_items.flatMap((item) => item.criterion_ids));
  for (const id of criterionIds) if (!covered.has(id)) throw new Error(`Plan omits criterion: ${id}`);
  return value;
}

export function validateImplementation(value, workItemIds) {
  validateSchema(value, implementationSchema, "implementation");
  assertObject(value, "implementation");
  if (!Array.isArray(value.work_items)) throw new Error("Implementation work_items must be an array");
  const seen = new Set();
  for (const item of value.work_items) {
    if (!workItemIds.has(item.id)) throw new Error(`Unknown implemented work item: ${item.id}`);
    if (seen.has(item.id)) throw new Error(`Duplicate implemented work item: ${item.id}`);
    seen.add(item.id);
    assertEnum(item.status, ["completed", "blocked", "skipped"], `implementation status for ${item.id}`);
  }
  for (const id of workItemIds) if (!seen.has(id)) throw new Error(`Implementation omits work item: ${id}`);
  if (!Array.isArray(value.changed_files) || !Array.isArray(value.blockers) || !Array.isArray(value.learning_candidates)) throw new Error("Implementation requires changed_files, blockers, and learning_candidates arrays");
  for (const candidate of value.learning_candidates) {
    for (const field of ["applies_when", "recommended", "avoid"]) if (typeof candidate?.[field] !== "string" || !candidate[field].trim()) throw new Error(`Learning candidate requires ${field}`);
    assertEnum(candidate.scope, ["project", "shared"], "learning candidate scope");
    if (!Array.isArray(candidate.tags)) throw new Error("Learning candidate tags must be an array");
    if (!Array.isArray(candidate.relations)) throw new Error("Learning candidate relations must be an array");
  }
  return value;
}

export function validateReview(value, criterionIds, knownEvidence) {
  validateSchema(value, reviewSchema, "review");
  assertObject(value, "review");
  if (!Array.isArray(value.criteria)) throw new Error("Review criteria must be an array");
  const seen = new Set();
  for (const criterion of value.criteria) {
    if (!criterionIds.has(criterion.id)) throw new Error(`Review references unknown criterion: ${criterion.id}`);
    if (seen.has(criterion.id)) throw new Error(`Duplicate criterion review: ${criterion.id}`);
    seen.add(criterion.id);
    assertEnum(criterion.verdict, ["pass", "fail", "unknown", "not_applicable"], `verdict for ${criterion.id}`);
    assertEnum(criterion.basis, ["review", "execution"], `basis for ${criterion.id}`);
    if (criterion.verdict === "pass" && criterion.evidence_refs.length === 0) throw new Error(`Passing criterion ${criterion.id} requires evidence`);
    if (criterion.basis === "execution" && criterion.verdict === "pass" && !criterion.evidence_refs.some((ref) => ref.startsWith("check:"))) throw new Error(`Execution criterion ${criterion.id} requires check evidence`);
    for (const ref of criterion.evidence_refs ?? []) if (!knownEvidence.has(ref)) throw new Error(`Review references unavailable evidence: ${ref}`);
  }
  if (seen.size !== criterionIds.size) throw new Error("Review must assess every acceptance criterion");
  for (const finding of value.findings ?? []) if (finding.evidence_ref && !knownEvidence.has(finding.evidence_ref)) throw new Error(`Finding references unavailable evidence: ${finding.evidence_ref}`);
  return value;
}

// Only the schema subset used by our four stage contracts; no dependency needed.
export function validateSchema(value, schema, path = "record", depth = 0) {
  if (depth > 40) throw new Error(`${path} exceeds maximum depth`);
  if (schema.type === "object") {
    assertObject(value, path);
    for (const field of schema.required ?? []) if (!Object.hasOwn(value, field)) throw new Error(`${path} is missing ${field}`);
    for (const [field, child] of Object.entries(value)) {
      if (!schema.properties?.[field]) {
        if (schema.additionalProperties === false) throw new Error(`${path} has unknown field ${field}`);
      } else validateSchema(child, schema.properties[field], `${path}.${field}`, depth + 1);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 100)) throw new Error(`${path} has invalid array size/type`);
    for (const item of value) validateSchema(item, schema.items, `${path}[]`, depth + 1);
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length > 30_000) throw new Error(`${path} requires a bounded string`);
  }
  if (schema.enum) assertEnum(value, schema.enum, path.split(".").at(-1));
}

function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`Invalid ${field}: ${value}`);
}

export async function readYaml(path) {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error(`Record exceeds ${MAX_RECORD_BYTES} bytes: ${path}`);
  return parse(text, { maxAliasCount: 0, uniqueKeys: true });
}

export async function writeYamlAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, stringify(value, { lineWidth: 0 }), { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function uniqueIds(items, name) {
  const ids = new Set();
  for (const item of items) {
    if (!item?.id || typeof item.id !== "string") throw new Error(`${name} requires a string id`);
    if (ids.has(item.id)) throw new Error(`Duplicate ${name} id: ${item.id}`);
    ids.add(item.id);
  }
}

function assertAcyclic(items) {
  const dependencies = new Map(items.map((item) => [item.id, item.dependencies ?? []]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`Plan contains a dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of dependencies.keys()) visit(id);
}
