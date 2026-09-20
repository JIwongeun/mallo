import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { discoverSkills, selectSkills } from "../src/catalog.mjs";

test("Mallo entry skill is excluded from worker selection by public and source identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-system-mallo-exclusion-"));
  try {
    const configPath = join(root, "skills.yaml");
    const path = resolve("plugins/codex-system/skills/mallo/SKILL.md");
    await writeFile(configPath, "schema_version: 2\ndisabled:\n  - codex-system:mallo\n  - plugin:codex-system:skills/mallo\nmandatory: []\npreferences: []\nlimits:\n  per_stage: 2\n");
    const client = { listSkills: async () => [{ skills: [
      { name: "codex-system:mallo", description: "Mallo entry", path, enabled: true, pluginId: null },
      { name: "mallo", description: "Mallo entry", path, enabled: true, pluginId: "codex-system" },
    ] }] };
    const selected = await selectSkills({ client, cwd: root, stage: "implementation", configPath, task: { request: "Use Mallo for this task" } });
    assert.equal(selected.length, 0);
    await assert.rejects(selectSkills({ client, cwd: root, stage: "implementation", configPath, explicitIds: ["codex-system:mallo"] }), /Explicit skill unavailable/);
    await assert.rejects(selectSkills({ client, cwd: root, stage: "implementation", configPath, explicitIds: ["plugin:codex-system:skills/mallo"] }), /Explicit skill unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("catalog refreshes changes and blocks missing mandatory skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-system-catalog-"));
  try {
    const path = join(root, "review", "SKILL.md");
    const configPath = join(root, "skills.yaml");
    await mkdir(join(root, "review"), { recursive: true });
    await writeFile(path, "---\nname: review-agent\ndescription: Review\n---\nFirst\n");
    await writeFile(configPath, "schema_version: 1\ndisabled: []\nmandatory:\n  - id: review-agent\n    stages: [review]\npreferences: []\nlimits:\n  per_stage: 2\n");
    let present = true;
    const client = { listSkills: async (_cwd, forceReload) => {
      assert.equal(forceReload, true);
      return [{ skills: present ? [{ name: "review-agent", path, enabled: true, pluginId: null }] : [] }];
    } };
    const first = await selectSkills({ client, cwd: root, stage: "review", configPath });
    await writeFile(path, "---\nname: review-agent\ndescription: Review\n---\nChanged\n");
    const changed = await selectSkills({ client, cwd: root, stage: "review", configPath });
    assert.notEqual(first[0].sha256, changed[0].sha256);
    present = false;
    await assert.rejects(selectSkills({ client, cwd: root, stage: "review", configPath }), /Mandatory skill unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog selects task-matched skills, respects explicit-only policy, and rejects ambiguous names", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-system-catalog-routing-"));
  try {
    const configPath = join(root, "skills.yaml");
    await writeFile(configPath, "schema_version: 2\ndisabled: []\nmandatory: []\npreferences: []\nconflict_groups:\n  - ids: [frontend-style, ui-audit]\nlimits:\n  per_stage: 2\n");
    const definitions = [
      ["react", "react-performance", "React and Next.js performance, components, data fetching", false],
      ["debug", "diagnosing-bugs", "Diagnose failing backend tests and reproduce bugs", false],
      ["style", "frontend-style", "Design and implement frontend interfaces", false],
      ["audit", "ui-audit", "Audit frontend accessibility and user interface design", false],
      ["manual", "grill-me", "Interview the user about product requirements", true],
      ["sheet", "xlsx", "Fix malformed spreadsheet files and avoid Google Sheets API integration", false],
      ["native", "vercel-react-native-skills", "React Native Expo performance for list rendering", false],
    ];
    const skills = [];
    for (const [folder, name, description, explicitOnly] of definitions) {
      const path = join(root, folder, "SKILL.md");
      await mkdir(join(root, folder, "agents"), { recursive: true });
      await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\nInstructions\n`);
      if (explicitOnly) await writeFile(join(root, folder, "agents", "openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
      skills.push({ name, description, path, enabled: true, pluginId: null, scope: "user" });
    }
    const client = { listSkills: async () => [{ skills }] };
    skills.find((skill) => skill.name === "react-performance").dependencies = { executables: ["node"] };
    const selected = await selectSkills({
      client, cwd: root, stage: "implementation", configPath,
      task: { request: "Next.js 화면의 data fetching 성능을 고쳐줘", search_terms: ["React", "Next.js", "performance", "data fetching"], affected_surfaces: ["frontend"], constraints: ["React Native and Expo list rendering are out of scope."] },
    });
    assert.equal(selected[0].name, "react-performance");
    assert.deepEqual(selected[0].dependencies, { executables: ["node"] });
    assert.ok(selected.every((skill) => skill.name !== "grill-me"));
    assert.ok(selected.every((skill) => skill.name !== "xlsx"));
    assert.ok(selected.every((skill) => !skill.name.includes("native")));
    assert.ok(selected.catalogRevision);
    const explicit = await selectSkills({ client, cwd: root, stage: "plan", configPath, task: { request: "$grill-me 요구사항을 정리해줘" } });
    assert.equal(explicit[0].name, "grill-me");
    const catalog = await discoverSkills({ client, cwd: root, configPath });
    assert.equal(catalog.skills.find((skill) => skill.name === "grill-me").explicit_only, true);
    await writeFile(configPath, "schema_version: 2\ndisabled: [ui-audit]\nmandatory: []\npreferences: []\nexplicit_only: [diagnosing-bugs]\nlimits:\n  per_stage: 2\n");
    const configured = await discoverSkills({ client, cwd: root, configPath });
    assert.notEqual(configured.revision, catalog.revision);
    const explicitConfigured = await selectSkills({ client, cwd: root, stage: "repair", configPath, explicitIds: ["diagnosing-bugs"], catalog: configured });
    assert.equal(explicitConfigured[0].explicit_only, true);

    const duplicatePath = join(root, "duplicate", "SKILL.md");
    await mkdir(join(root, "duplicate"), { recursive: true });
    await writeFile(duplicatePath, "---\nname: react-performance\ndescription: Duplicate\n---\nDuplicate\n");
    skills.push({ name: "react-performance", description: "Duplicate", path: duplicatePath, enabled: true, pluginId: "other", scope: "plugin" });
    await assert.rejects(selectSkills({ client, cwd: root, stage: "implementation", configPath, explicitIds: ["react-performance"] }), /ambiguous/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing worker dependencies exclude optional skills and block required skills without installing", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-system-dependencies-"));
  try {
    const configPath = join(root, "skills.yaml");
    const path = join(root, "SKILL.md");
    await writeFile(path, "---\nname: documents\ndescription: Create documents\n---\nUse document tools.\n");
    await writeFile(configPath, "schema_version: 2\nmandatory: []\npreferences: []\n");
    const skill = { name: "documents", description: "Create documents", path, enabled: true, dependencies: { tools: [{ type: "mcp", value: "documents" }] } };
    let available = false;
    const client = { listSkills: async () => [{ skills: [skill] }], listMcpServers: async () => available ? [{ name: "documents", tools: { render: {} }, runtimeStatus: "connected", toolsError: null }] : [] };
    const args = { client, cwd: root, stage: "implementation", configPath, task: { request: "Create documents" } };
    const omitted = await selectSkills(args);
    assert.equal(omitted.length, 0);
    assert.equal(omitted.excluded[0].reason, "missing_dependency");
    await assert.rejects(selectSkills({ ...args, explicitIds: ["documents"] }), /Required skill dependencies unavailable.*mcp:documents/);
    available = true;
    assert.equal((await selectSkills(args))[0].name, "documents");
    skill.dependencies = { executables: ["codex-system-nonexistent-runtime-123"] };
    assert.equal((await selectSkills(args)).length, 0);
    skill.dependencies = { files: ["../outside.txt"] };
    await assert.rejects(selectSkills({ ...args, explicitIds: ["documents"] }), /dependencies unavailable/);
    await writeFile(configPath, "schema_version: 2\nmandatory: []\ndependencies:\n  documents:\n    tools: malformed\n");
    await assert.rejects(selectSkills(args), /Invalid skill dependencies.tools/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
