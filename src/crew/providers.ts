import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

// Multi-provider agent runners: each CLI is a different subscription
// with its own quota, so the factory treats the runner as a routing
// choice, not a constant. A provider definition knows how to spawn one
// headless station, whether/how it resumes a session, and how to read
// its reply. Only providers whose binary is on PATH are selectable in
// Settings; the rest render as "not installed".

export const PROVIDER_IDS = [
  "muse",
  "agy",
  "gemini",
  "claude",
  "codex",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderRoute {
  provider: ProviderId;
  model: string;
  effort: string; // low|medium|high — providers without an effort flag ignore it
}

export type ProviderOutput = "muse-jsonl" | "claude-json" | "text";

export interface ProviderDef {
  id: ProviderId;
  label: string;
  binary: string;
  output: ProviderOutput;
  /** Models offered as suggestions; other names may be typed freely. */
  suggestedModels: string[];
  judgmentModel: string; // strong model for planner/red-team/review stations
  executionModel: string; // fast model for builder/coder/QC stations
  supportsEffort: boolean;
  supportsResume: boolean;
  buildArgs(input: {
    model: string;
    effort: string;
    resumeId: string | null;
    prompt: string;
  }): string[];
}

const effortArgs = (flag: string, effort: string, model: string, enabled = true): string[] =>
  enabled && model
    ? [
        flag,
        effort,
      ]
    : [];

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  muse: {
    id: "muse",
    label: "Muse (Meta)",
    binary: "muse",
    output: "muse-jsonl",
    suggestedModels: [
      "muse-wonder-1.0",
      "muse-spark-1.3",
    ],
    judgmentModel: "muse-wonder-1.0",
    executionModel: "muse-spark-1.3",
    supportsEffort: true,
    supportsResume: true,
    buildArgs: ({ model, effort, resumeId, prompt }) => [
      "muse",
      "exec",
      "--json",
      ...(model
        ? [
            "--model",
            model,
            "--reasoning-effort",
            effort || "medium",
          ]
        : []),
      ...(resumeId
        ? [
            "--session-id",
            resumeId,
          ]
        : []),
      prompt,
    ],
  },
  agy: {
    id: "agy",
    label: "Antigravity (agy)",
    binary: "agy",
    output: "text",
    suggestedModels: [
      "gemini-3-pro",
      "gemini-3-flash",
      "claude-sonnet-4-5",
    ],
    judgmentModel: "gemini-3-pro",
    executionModel: "gemini-3-flash",
    supportsEffort: true,
    supportsResume: true,
    buildArgs: ({ model, effort, resumeId, prompt }) => [
      "agy",
      "--print",
      prompt,
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
      ...(model
        ? [
            "--model",
            model,
          ]
        : []),
      ...effortArgs("--effort", effort || "medium", model || "x"),
      ...(resumeId
        ? [
            "--conversation",
            resumeId,
          ]
        : []),
    ],
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    binary: "gemini",
    output: "text",
    suggestedModels: [
      "gemini-3-pro",
      "gemini-3-flash",
    ],
    judgmentModel: "gemini-3-pro",
    executionModel: "gemini-3-flash",
    supportsEffort: false,
    supportsResume: false,
    buildArgs: ({ model, prompt }) => [
      "gemini",
      "-p",
      prompt,
      "-y",
      "--skip-trust",
      ...(model
        ? [
            "-m",
            model,
          ]
        : []),
    ],
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    output: "claude-json",
    suggestedModels: [
      "claude-opus-4-5",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ],
    judgmentModel: "claude-opus-4-5",
    executionModel: "claude-sonnet-4-5",
    supportsEffort: false,
    supportsResume: true,
    buildArgs: ({ model, resumeId, prompt }) => [
      "claude",
      "-p",
      prompt,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      ...(model
        ? [
            "--model",
            model,
          ]
        : []),
      ...(resumeId
        ? [
            "--resume",
            resumeId,
          ]
        : []),
    ],
  },
  codex: {
    id: "codex",
    label: "Codex",
    binary: "codex",
    output: "text",
    suggestedModels: [
      "gpt-5.1-codex",
      "gpt-5.1",
    ],
    judgmentModel: "gpt-5.1-codex",
    executionModel: "gpt-5.1-codex",
    supportsEffort: false,
    supportsResume: false,
    buildArgs: ({ model, prompt }) => [
      "codex",
      "exec",
      prompt,
      "--full-auto",
      ...(model
        ? [
            "-m",
            model,
          ]
        : []),
    ],
  },
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** Binary detected on PATH (the only runnability fact we can prove offline). */
export function providerInstalled(id: ProviderId, pathEnv = process.env.PATH ?? ""): boolean {
  const binary = PROVIDERS[id].binary;
  return pathEnv.split(delimiter).some((dir) => dir && existsSync(join(dir, binary)));
}

export interface ProviderInfo extends Omit<ProviderDef, "buildArgs"> {
  installed: boolean;
}

export function providerCatalogue(): ProviderInfo[] {
  return PROVIDER_IDS.map((id) => {
    const { buildArgs: _buildArgs, ...rest } = PROVIDERS[id];
    return {
      ...rest,
      installed: providerInstalled(id),
    };
  });
}

export interface ParsedProviderOutput {
  reply: string;
  sessionId: string | null;
  completed: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

/** Read a non-muse provider's stdout. Muse output goes through preset.ts. */
export function parseProviderOutput(
  def: ProviderDef,
  stdout: string,
  exitCode: number,
): ParsedProviderOutput {
  const trimmed = stdout.trim();
  if (def.output === "claude-json") {
    try {
      const obj = JSON.parse(trimmed) as {
        result?: string;
        session_id?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
        };
      };
      return {
        reply: String(obj.result ?? ""),
        sessionId: obj.session_id ?? null,
        completed: exitCode === 0 && typeof obj.result === "string",
        ...(typeof obj.usage?.input_tokens === "number"
          ? {
              inputTokens: obj.usage.input_tokens,
            }
          : {}),
        ...(typeof obj.usage?.output_tokens === "number"
          ? {
              outputTokens: obj.usage.output_tokens,
            }
          : {}),
      };
    } catch {
      return {
        reply: trimmed,
        sessionId: null,
        completed: false,
      };
    }
  }
  // Plain text: the whole stdout is the reply; success is the exit code.
  return {
    reply: trimmed,
    sessionId: null,
    completed: exitCode === 0 && trimmed.length > 0,
  };
}

export function validateRoute(value: unknown): ProviderRoute | null {
  if (!value || typeof value !== "object") return null;
  const v = value as {
    provider?: unknown;
    model?: unknown;
    effort?: unknown;
  };
  const provider = String(v.provider ?? "muse");
  if (!isProviderId(provider)) return null;
  const model = String(v.model ?? "").slice(0, 80);
  const effort = [
    "low",
    "medium",
    "high",
  ].includes(String(v.effort))
    ? String(v.effort)
    : "medium";
  return {
    provider,
    model,
    effort,
  };
}

export const STATION_ROLES = [
  "planner",
  "redteam",
  "sme",
  "coder",
  "outsider",
  "builder",
  "qc",
  "fixer",
] as const;
export type StationRole = (typeof STATION_ROLES)[number];
const JUDGMENT: ReadonlySet<string> = new Set([
  "planner",
  "redteam",
  "sme",
]);

export interface PresetCriticalLevels {
  onQuota: boolean;
  failureRatePercent: number; // 0 = off; switches before a station when recent failed outcomes reach it
  errorRatePercent: number; // 0 = off; provider/CLI errors only
  minSamples: number;
}

export const DEFAULT_CRITICAL_LEVELS: PresetCriticalLevels = {
  onQuota: true,
  failureRatePercent: 0,
  errorRatePercent: 0,
  minSamples: 5,
};

export interface StationPreset {
  id: string;
  name: string;
  routes: Record<StationRole, ProviderRoute>;
  critical: PresetCriticalLevels;
}

export type ProviderOutcome = "success" | "failure" | "error" | "quota";

export interface ProviderHealth {
  samples: number;
  failures: number;
  errors: number;
  failureRatePercent: number;
  errorRatePercent: number;
}

export function healthFromOutcomes(outcomes: ProviderOutcome[], windowSize = 20): ProviderHealth {
  const recent = outcomes.filter((o) => o !== "quota").slice(-Math.max(1, windowSize));
  const failures = recent.filter((o) => o === "failure" || o === "error").length;
  const errors = recent.filter((o) => o === "error").length;
  const rate = (n: number) => (recent.length ? Math.round((n / recent.length) * 100) : 0);
  return {
    samples: recent.length,
    failures,
    errors,
    failureRatePercent: rate(failures),
    errorRatePercent: rate(errors),
  };
}

/** Why this preset should be skipped for the next one, or null when it may run. */
export function presetSwitchReason(preset: StationPreset, health: ProviderHealth): string | null {
  const critical = preset.critical ?? DEFAULT_CRITICAL_LEVELS;
  if (health.samples < critical.minSamples) return null;
  if (critical.failureRatePercent > 0 && health.failureRatePercent >= critical.failureRatePercent)
    return `failure rate ${health.failureRatePercent}% reached critical ${critical.failureRatePercent}% (${health.failures}/${health.samples} recent stations)`;
  if (critical.errorRatePercent > 0 && health.errorRatePercent >= critical.errorRatePercent)
    return `provider error rate ${health.errorRatePercent}% reached critical ${critical.errorRatePercent}% (${health.errors}/${health.samples} recent stations)`;
  return null;
}

const PROVIDER_ERROR_RE =
  /\b(429|5\d\d)\b|api|network|socket|timeout|timed out|spawn|cli|unauthor|permission denied|command not found|failed to acquire|session.*lock/i;

export function classifyProviderOutcome(input: {
  done: boolean;
  timedOut: boolean;
  reply: string;
  stderr: string;
}): Exclude<ProviderOutcome, "quota"> {
  if (input.done) return "success";
  if (
    input.timedOut ||
    !input.reply.trim() ||
    PROVIDER_ERROR_RE.test(`${input.reply}\n${input.stderr}`)
  )
    return "error";
  return "failure";
}

function validateCriticalLevels(value: unknown): PresetCriticalLevels {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const percent = (x: unknown) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
  };
  const samples = Number(v.minSamples);
  return {
    onQuota: v.onQuota !== false,
    failureRatePercent: percent(v.failureRatePercent),
    errorRatePercent: percent(v.errorRatePercent),
    minSamples: Number.isFinite(samples)
      ? Math.min(100, Math.max(1, Math.floor(samples)))
      : DEFAULT_CRITICAL_LEVELS.minSamples,
  };
}

function routeFor(role: StationRole, build: ProviderId, check: ProviderId): ProviderRoute {
  const provider = JUDGMENT.has(role) ? check : build;
  const def = PROVIDERS[provider];
  return {
    provider,
    model: JUDGMENT.has(role) ? def.judgmentModel : def.executionModel,
    effort: JUDGMENT.has(role) ? "high" : role === "outsider" ? "low" : "medium",
  };
}

function routesFor(build: ProviderId, check: ProviderId): Record<StationRole, ProviderRoute> {
  return {
    planner: routeFor("planner", build, check),
    redteam: routeFor("redteam", build, check),
    sme: routeFor("sme", build, check),
    coder: routeFor("coder", build, check),
    outsider: routeFor("outsider", build, check),
    builder: routeFor("builder", build, check),
    qc: routeFor("qc", build, check),
    fixer: routeFor("fixer", build, check),
  };
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  muse: "Muse",
  agy: "Gemini (agy)",
  gemini: "Gemini",
  claude: "Claude",
  codex: "Codex",
};

/**
 * Presets worth offering for the runners actually installed: one
 * single-provider preset each, plus cross-family pairs where code is
 * written by one model family and checked by a different subscription —
 * independent checking is the factory's core rule, so the suggested
 * default for any second provider is "builds here, checked by muse".
 */
export function suggestedPresets(installed: ProviderId[]): StationPreset[] {
  const has = (id: ProviderId) => installed.includes(id);
  const presets: StationPreset[] = [];
  if (has("muse"))
    presets.push({
      id: "preset-muse",
      name: "Muse — judgment & build (Meta)",
      routes: routesFor("muse", "muse"),
      critical: {
        ...DEFAULT_CRITICAL_LEVELS,
      },
    });
  for (const id of installed) {
    if (id === "muse") continue;
    presets.push({
      id: `preset-${id}`,
      name: `${PROVIDER_LABEL[id]} — everything`,
      routes: routesFor(id, id),
      critical: {
        ...DEFAULT_CRITICAL_LEVELS,
      },
    });
    if (has("muse")) {
      presets.push({
        id: `preset-${id}-builds`,
        name: `${PROVIDER_LABEL[id]} builds, Muse checks`,
        routes: routesFor(id, "muse"),
        critical: {
          ...DEFAULT_CRITICAL_LEVELS,
        },
      });
      presets.push({
        id: `preset-muse-builds-${id}`,
        name: `Muse builds, ${PROVIDER_LABEL[id]} checks`,
        routes: routesFor("muse", id),
        critical: {
          ...DEFAULT_CRITICAL_LEVELS,
        },
      });
    }
  }
  return presets;
}

export function validatePreset(value: unknown): StationPreset | null {
  if (!value || typeof value !== "object") return null;
  const v = value as {
    id?: unknown;
    name?: unknown;
    routes?: unknown;
    critical?: unknown;
  };
  const id = String(v.id ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 60);
  if (!id || !v.routes || typeof v.routes !== "object") return null;
  const byRole = new Map<StationRole, ProviderRoute>();
  for (const role of STATION_ROLES) {
    const route = validateRoute((v.routes as Record<string, unknown>)[role]);
    if (!route) return null;
    if (
      route.provider === "muse" &&
      !(PROVIDERS.muse.suggestedModels as string[]).includes(route.model)
    )
      return null;
    byRole.set(role, route);
  }
  const need = (role: StationRole): ProviderRoute => {
    const route = byRole.get(role);
    if (!route) throw new Error(`preset route missing for ${role}`);
    return route;
  };
  const routes: Record<StationRole, ProviderRoute> = {
    planner: need("planner"),
    redteam: need("redteam"),
    sme: need("sme"),
    coder: need("coder"),
    outsider: need("outsider"),
    builder: need("builder"),
    qc: need("qc"),
    fixer: need("fixer"),
  };
  return {
    id,
    name: String(v.name ?? id).slice(0, 80) || id,
    routes,
    critical: validateCriticalLevels(v.critical),
  };
}
