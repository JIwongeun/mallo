import { readYaml } from "./contracts.mjs";

const HIGH_RISK = /\b(auth|authentication|authorization|login|password|token|credential|permission|payment|billing|delete|migration|production|deploy)\b|인증|로그인|비밀번호|토큰|권한|결제|삭제|마이그레이션|배포/i;

export async function loadRouting(path) {
  const config = await readYaml(path);
  if (config?.schema_version !== 1) throw new Error("Unsupported routing configuration");
  return validateRouting(config);
}

export async function loadEffectiveRouting(defaultPath, settingsPath) {
  const defaults = await loadRouting(defaultPath);
  let settings;
  try { settings = await readYaml(settingsPath); }
  catch (error) { if (error.code === "ENOENT") return defaults; throw error; }
  if (settings?.schema_version !== 1) throw new Error("Unsupported Relay settings schema");
  const allowed = new Set(["schema_version", "routing"]);
  for (const key of Object.keys(settings)) if (!allowed.has(key)) throw new Error(`Unknown Relay setting: ${key}`);
  const override = settings.routing ?? {};
  return validateRouting({
    ...defaults,
    effort: { ...defaults.effort, ...(override.effort ?? {}) },
    limits: { ...defaults.limits, ...(override.limits ?? {}) },
  });
}

export function validateRouting(config) {
  if (config?.models?.planning !== "gpt-6-astra" || config?.models?.implementation !== "gpt-5.6-sol") throw new Error("Routing requires Astra planning and Sol implementation");
  if (config.effort?.triage !== "medium" || config.effort?.normal !== "high" || config.effort?.complex !== "xhigh") throw new Error("Routing efforts must be medium/high/xhigh");
  for (const [key, cap] of [["sol_repairs", 2], ["astra_replans", 1]]) {
    if (!Number.isInteger(config.limits?.[key]) || config.limits[key] < 0 || config.limits[key] > cap) throw new Error(`Invalid retry limit: ${key}`);
  }
  return config;
}

export function routeTask(facts, request, config) {
  validateRouting(config);
  const planningOnly = facts.task_kind === "planning";
  const reviewOnly = facts.task_kind === "review";
  const highRisk = facts.risk === "high" || HIGH_RISK.test([request, ...(facts.affected_surfaces ?? [])].join(" "));
  const requiresPlan = planningOnly || reviewOnly || highRisk || facts.risk !== "low" || facts.complexity !== "simple" || facts.ambiguity !== "low";
  const route = requiresPlan ? "planned" : "simple";
  const effort = facts.complexity === "complex" || facts.ambiguity === "high" || highRisk
    ? config.effort.complex
    : config.effort.normal;
  return {
    route,
    planningOnly,
    reviewOnly,
    highRisk,
    reasons: [
      ...(planningOnly ? ["planning-only task"] : []),
      ...(highRisk ? ["high-risk surface"] : []),
      ...(facts.complexity !== "simple" ? [`${facts.complexity} complexity`] : []),
      ...(facts.ambiguity !== "low" ? [`${facts.ambiguity} ambiguity`] : []),
    ],
    stages: reviewOnly ? ["triage", "check", "review", "record"] : planningOnly ? ["triage", "plan", "plan-review", "record"] : route === "simple" ? ["triage", "implement", "check", "assess", "record"] : ["triage", "plan", "plan-review", "implement", "check", "review", "record"],
    models: { planning: config.models.planning, implementation: config.models.implementation },
    efforts: { triage: config.effort.triage, planning: effort, implementation: effort, review: effort },
    limits: config.limits,
  };
}
