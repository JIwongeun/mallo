import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { readYaml } from "./contracts.mjs";
import { findExecutable } from "./doctor.mjs";
import { isWithin } from "./bindings.mjs";

const STOP_WORDS = new Set([
  "about", "after", "agent", "and", "any", "api", "are", "before", "change", "code", "create", "does",
  "build", "existing", "file", "files", "fix", "for", "from", "implement", "into", "make", "malformed", "not", "only",
  "plan", "planning", "project", "recommendations", "request", "review", "skill", "task", "test", "tests", "that", "the", "this", "use", "user", "using", "when", "with", "without",
]);
const GENERIC_SKILL_NAME_TERMS = new Set([
  "audit", "backend", "best", "bugs", "coding", "design", "diagnosing", "frontend", "guidelines", "patterns",
  "performance", "practices", "review", "skills", "testing", "tests", "tool", "tools", "vercel", "workflow",
]);

export async function discoverSkills({ client, cwd, configPath }) {
  const config = await readYaml(configPath);
  validateConfig(config);
  const entries = await client.listSkills(cwd, true);
  const errors = entries.flatMap((entry) => entry.errors ?? []);
  const discovered = entries.flatMap((entry) => entry.skills ?? []);
  const skills = [];
  for (const skill of discovered) {
    if (!skill?.enabled || typeof skill.name !== "string" || typeof skill.path !== "string") continue;
    const path = await realpath(resolve(skill.path));
    const root = dirname(path);
    const source = stableSourceId(path, skill.pluginId);
    skills.push({
      id: source,
      name: skill.name,
      description: skill.description ?? skill.shortDescription ?? "",
      path,
      root,
      scope: skill.scope ?? null,
      plugin_id: skill.pluginId ?? null,
      dependencies: skill.dependencies ?? null,
      explicit_only: await explicitOnlyPolicy(root),
      descriptor_sha256: await hashDescriptor(path, root),
    });
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema_version: 2,
    revision: createHash("sha256").update(JSON.stringify({
      skills: skills.map(({ id, descriptor_sha256, dependencies }) => [id, descriptor_sha256, dependencies]),
      config,
    })).digest("hex"),
    skills,
    errors,
    config,
  };
}

export async function selectSkills({ client, cwd, stage, configPath, task = null, explicitIds = [], catalog: suppliedCatalog = null }) {
  const catalog = suppliedCatalog ?? await discoverSkills({ client, cwd, configPath });
  const disabled = new Set(catalog.config.disabled ?? []);
  const available = catalog.skills.filter((skill) => !disabled.has(skill.id) && !disabled.has(skill.name));
  const requested = new Set([...explicitIds, ...explicitMentions(task?.request ?? "")]);
  const selected = [];
  const excluded = [];
  const dependencyContext = { client, cwd };

  for (const requirement of catalog.config.mandatory ?? []) {
    if (!(requirement.stages ?? []).includes(stage)) continue;
    selected.push({ skill: resolveOne(available, requirement.id, stage), reason: "mandatory" });
  }

  for (const id of requested) {
    const matches = matchesIdentity(available, id);
    if (matches.length === 0) throw new Error(`Explicit skill unavailable: ${id}`);
    if (matches.length > 1) throw new Error(`Explicit skill is ambiguous: ${id}`);
    if (!selected.some((entry) => entry.skill.id === matches[0].id)) selected.push({ skill: matches[0], reason: "explicit_request" });
  }

  const conflictGroups = catalog.config.conflict_groups ?? [];
  for (const [index, entry] of selected.entries()) {
    if (conflicts(entry.skill, selected.slice(0, index).map((item) => item.skill), conflictGroups)) throw new Error(`Required skills conflict: ${entry.skill.id}`);
    const failures = await dependencyFailures(entry.skill, catalog.config, dependencyContext);
    if (failures.length) throw new Error(`Required skill dependencies unavailable: ${entry.skill.id}: ${failures.join(", ")}`);
  }

  const terms = taskTerms(task);
  const preferences = new Map((catalog.config.preferences ?? [])
    .filter((entry) => (entry.stages ?? []).includes(stage))
    .map((entry, index) => [entry.id, 20 - index]));
  const candidates = [];
  for (const skill of available) {
    if (selected.some((entry) => entry.skill.id === skill.id)) continue;
    const configuredExplicitOnly = (catalog.config.explicit_only ?? []).some((id) => matchesIdentity([skill], id).length);
    if (skill.explicit_only || configuredExplicitOnly) { excluded.push({ id: skill.id, reason: "explicit_only" }); continue; }
    const preference = [...preferences.entries()].find(([id]) => matchesIdentity([skill], id).length)?.[1] ?? 0;
    const matched = matchingTerms(skill, terms);
    const nameTerms = new Set(tokenize(skill.name.split(":").at(-1).replace(/[:_.+\-]+/g, " ")));
    const discriminators = [...nameTerms].filter((term) => !GENERIC_SKILL_NAME_TERMS.has(term));
    const discriminatorHits = discriminators.filter((term) => terms.has(term)).length;
    const nameCompatible = discriminators.every((term) => terms.has(term));
    const taskMatch = nameCompatible && (matched.length >= 2 || matched.some((term) => nameTerms.has(term)));
    const score = preference + matched.length * 3 + discriminatorHits * 5 + (stageMatch(skill, stage) ? 1 : 0);
    if (score > 0 && (preference > 0 || taskMatch)) candidates.push({ skill, score, matched, reason: preference > 0 ? (taskMatch ? "preference_and_task_match" : "preference") : "task_match" });
    else excluded.push({ id: skill.id, reason: "no_task_match" });
  }
  candidates.sort((a, b) => b.score - a.score || b.matched.length - a.matched.length || a.skill.id.localeCompare(b.skill.id));

  const limit = catalog.config.limits?.per_stage ?? 2;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10 || selected.length > limit) throw new Error(`Skill limit cannot satisfy required skills for ${stage}`);
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (conflicts(candidate.skill, selected.map((entry) => entry.skill), conflictGroups)) {
      excluded.push({ id: candidate.skill.id, reason: "conflict" });
      continue;
    }
    const failures = await dependencyFailures(candidate.skill, catalog.config, dependencyContext);
    if (failures.length) {
      excluded.push({ id: candidate.skill.id, reason: "missing_dependency", details: failures });
      continue;
    }
    selected.push(candidate);
  }

  const pins = catalog.config.pins ?? {};
  const resolved = await Promise.all(selected.map(async ({ skill, reason, matched = [] }) => {
    const contentSha256 = await hashTree(skill.root);
    const pin = pins[skill.id] ?? pins[skill.name];
    if (pin && pin !== contentSha256) throw new Error(`Pinned skill source changed: ${skill.id}`);
    return {
      id: skill.id,
      name: skill.name,
      path: skill.path,
      plugin_id: skill.plugin_id,
      scope: skill.scope,
      dependencies: combinedDependencies(skill, catalog.config),
      content_sha256: contentSha256,
      sha256: contentSha256,
      explicit_only: skill.explicit_only || (catalog.config.explicit_only ?? []).some((id) => matchesIdentity([skill], id).length),
      selection_reason: reason,
      matched_terms: matched.slice(0, 8),
    };
  }));
  Object.defineProperties(resolved, {
    catalogRevision: { value: catalog.revision, enumerable: false },
    excluded: { value: excluded, enumerable: false },
    discoveryErrors: { value: catalog.errors, enumerable: false },
  });
  return resolved;
}

function validateConfig(config) {
  if (![1, 2].includes(config?.schema_version)) throw new Error("Unsupported skills configuration");
  for (const key of ["disabled", "explicit_only", "mandatory", "preferences", "conflict_groups"]) if (config[key] !== undefined && !Array.isArray(config[key])) throw new Error(`skills.${key} must be an array`);
  for (const key of ["disabled", "explicit_only"]) for (const id of config[key] ?? []) if (typeof id !== "string" || !id) throw new Error(`Invalid skills.${key} identity`);
  for (const key of ["mandatory", "preferences"]) for (const entry of config[key] ?? []) if (typeof entry?.id !== "string" || !entry.id || !Array.isArray(entry.stages) || entry.stages.some((stage) => !["triage", "plan", "implementation", "repair", "review"].includes(stage))) throw new Error(`Invalid skills.${key} entry`);
  for (const group of config.conflict_groups ?? []) if (!Array.isArray(group.ids ?? group) || (group.ids ?? group).some((id) => typeof id !== "string" || !id)) throw new Error("Invalid skill conflict group");
  for (const key of ["pins", "dependencies"]) if (config[key] !== undefined && (!config[key] || typeof config[key] !== "object" || Array.isArray(config[key]))) throw new Error(`skills.${key} must be a map`);
  for (const hash of Object.values(config.pins ?? {})) if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid skill source pin");
  for (const dependency of Object.values(config.dependencies ?? {})) validateDependencies(dependency);
}

function combinedDependencies(skill, config) {
  const overrides = config.dependencies?.[skill.id] ?? config.dependencies?.[skill.name];
  if (!overrides) return skill.dependencies ?? null;
  return Object.fromEntries(["tools", "executables", "files"].map((key) => [key, [...(skill.dependencies?.[key] ?? []), ...(overrides[key] ?? [])]]));
}

function validateDependencies(dependencies) {
  if (dependencies == null) return;
  if (typeof dependencies !== "object" || Array.isArray(dependencies)) throw new Error("Invalid skill dependencies");
  for (const key of Object.keys(dependencies)) if (!["tools", "executables", "files"].includes(key)) throw new Error(`Unsupported dependency kind: ${key}`);
  for (const key of ["tools", "executables", "files"]) if (dependencies[key] !== undefined && !Array.isArray(dependencies[key])) throw new Error(`Invalid skill dependencies.${key}`);
  for (const value of [...(dependencies.executables ?? []), ...(dependencies.files ?? [])]) if (typeof value !== "string" || !value) throw new Error("Invalid dependency path/name");
  for (const tool of dependencies.tools ?? []) if (typeof tool?.type !== "string" || typeof tool.value !== "string" || !tool.value) throw new Error("Invalid skill tool dependency");
}

async function dependencyFailures(skill, config, context) {
  const dependencies = combinedDependencies(skill, config);
  try { validateDependencies(dependencies); } catch (error) { return [error.message]; }
  const failures = [];
  for (const name of dependencies?.executables ?? []) if (!await findExecutable(name)) failures.push(`executable:${name}`);
  for (const file of dependencies?.files ?? []) {
    try {
      const path = await realpath(resolve(skill.root ?? dirname(skill.path), file));
      if (!isWithin(skill.root ?? dirname(skill.path), path)) throw new Error("outside source");
      await readFile(path);
    } catch { failures.push(`file:${file}`); }
  }
  for (const tool of dependencies?.tools ?? []) {
    if (tool.type !== "mcp") { failures.push(`unverified_tool:${tool.type}:${tool.value}`); continue; }
    context.servers ??= context.client.listMcpServers ? context.client.listMcpServers(context.threadId).catch(() => []) : Promise.resolve([]);
    const servers = await context.servers;
    if (!servers.some((server) => server.name === tool.value && !server.toolsError && Object.keys(server.tools ?? {}).length && !["failed", "disabled", "authenticationRequired", "cancelled"].includes(server.runtimeStatus))) failures.push(`mcp:${tool.value}`);
  }
  return failures;
}

export async function validateWorkerSkillDependencies({ client, cwd, threadId, skills }) {
  const context = { client, cwd, threadId };
  for (const skill of skills) {
    const failures = await dependencyFailures(skill, {}, context);
    if (failures.length) throw new Error(`Worker skill dependencies unavailable: ${skill.id}: ${failures.join(", ")}`);
  }
}

function stableSourceId(path, pluginId) {
  const normalized = path.replaceAll("\\", "/");
  const skillSegment = normalized.match(/\/skills\/(.+)\/SKILL\.md$/i)?.[1];
  if (pluginId) return `plugin:${pluginId}:${skillSegment ? `skills/${skillSegment}` : normalized.split("/").at(-2)}`;
  const userSegment = normalized.match(/\/(\.codex|\.agents)\/skills\/(.+)\/SKILL\.md$/i);
  if (userSegment) return `user:${userSegment[1].toLowerCase()}:${userSegment[2].toLowerCase()}`;
  return `path:${dirname(path).toLowerCase()}`;
}

function resolveOne(skills, id, stage) {
  const matches = matchesIdentity(skills, id);
  if (matches.length === 0) throw new Error(`Mandatory skill unavailable for ${stage}: ${id}`);
  if (matches.length > 1) throw new Error(`Mandatory skill is ambiguous for ${stage}: ${id}`);
  return matches[0];
}

function matchesIdentity(skills, id) {
  return skills.filter((skill) => skill.id === id || skill.name === id);
}

function explicitMentions(request) {
  return [...request.matchAll(/(?:^|\s)\$([\w:.-]+)/g)].map((match) => match[1]);
}

function taskTerms(task) {
  if (!task) return new Set();
  // Constraints often name excluded technologies; they are not positive routing evidence.
  const values = [task.request, task.task_kind, ...(task.search_terms ?? []), ...(task.affected_surfaces ?? [])];
  return new Set(tokenize(values.filter(Boolean).join(" ")));
}

function tokenize(value) {
  return (value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.+-]{2,}/gu) ?? [])
    .map((term) => term.replace(/^[_.+\-]+|[_.+\-]+$/g, ""))
    .filter((term) => term && !STOP_WORDS.has(term));
}

function matchingTerms(skill, terms) {
  const haystack = new Set(tokenize(`${skill.name} ${skill.description}`));
  return [...terms].filter((term) => haystack.has(term));
}

function stageMatch(skill, stage) {
  const text = `${skill.name} ${skill.description}`.toLowerCase();
  if (stage === "review") return /review|audit|verify|verification/.test(text);
  if (stage === "repair") return /debug|diagnos|repair|fix/.test(text);
  if (stage === "plan") return /plan|design|architect|brainstorm/.test(text);
  return /implement|coding|develop|frontend|backend|react|next/.test(text);
}

function conflicts(skill, selected, groups) {
  return groups.some((group) => {
    const ids = group.ids ?? group;
    return Array.isArray(ids) && ids.some((id) => matchesIdentity([skill], id).length) && selected.some((entry) => ids.some((id) => matchesIdentity([entry], id).length));
  });
}

async function explicitOnlyPolicy(root) {
  try {
    const metadata = await readYaml(resolve(root, "agents", "openai.yaml"));
    return metadata?.policy?.allow_implicit_invocation === false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

async function hashTree(root) {
  const parts = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) parts.push(`${relative(root, path).replaceAll("\\", "/")}\0${createHash("sha256").update(await readFile(path)).digest("hex")}`);
    }
  }
  await visit(root);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

async function hashDescriptor(path, root) {
  const parts = [["SKILL.md", createHash("sha256").update(await readFile(path)).digest("hex")]];
  try { parts.push(["agents/openai.yaml", createHash("sha256").update(await readFile(resolve(root, "agents", "openai.yaml"))).digest("hex")]); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
