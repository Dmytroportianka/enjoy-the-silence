// Agent scaffolding for special cases the deterministic wizard templates
// do not cover. Hybrid by design: generateWizardFiles pours the base, a
// Muse builder session proposes a file delta for the user's special
// cases, and a SEPARATE Muse QC session (new process, no shared session)
// must pass it before anything is written. Generate-only: this module
// returns files; it never applies a config, runs nixos-rebuild, or tofu.
// Dependency-free (no zod) so the wizard path runs without install.
import type { WizardAnswers } from "./wizard";

export type AgentRunner = (prompt: string) => Promise<string>;

export interface ScaffoldResult {
  files: Map<string, string>;
  changed: string[];
  builderSummary: string;
  qcSummary: string;
}

export class QcVetoError extends Error {}

const SECRET_SHAPE =
  /[0-9]{8,10}:[A-Za-z0-9_-]{35}|BOT_TOKEN=|META_API_KEY=[A-Za-z0-9]{8,}|HCLOUD_TOKEN=[A-Za-z0-9]|DIGITALOCEAN_TOKEN=[A-Za-z0-9]/;

export function validateAgentFile(path: string, content: string): void {
  if (!path || path.startsWith("/") || path.startsWith("\\") || path.split("/").includes("..")) {
    throw new Error(`unsafe agent file path: ${path}`);
  }
  if (/telegram/i.test(path) || /telegram/i.test(content)) {
    throw new Error(`agent file reintroduces removed telegram integration: ${path}`);
  }
  if (SECRET_SHAPE.test(content)) {
    throw new Error(`agent file contains a secret-shaped value: ${path}`);
  }
}

function fileBlock(files: Map<string, string>): string {
  return [
    ...files.entries(),
  ]
    .map(([name, content]) => `--- ${name} ---\n${content}`)
    .join("\n");
}

const TARGET_CONTEXT: Record<WizardAnswers["target"], string> = {
  incus:
    "Target is a throwaway Incus container: no real hardware config, demo-safe defaults, everything deletable with the container.",
  clean:
    "Target is a clean NixOS install on real hardware (often a machine on the local network): tailor to that machine's disks, network, and users. The wizard is run on the target itself, so inspect it read-only if needed; hardware-configuration.nix stays a placeholder the user replaces with nixos-generate-config output.",
  existing:
    "Target is an existing NixOS host: add the agent layer as an importable module only; never overwrite the host's own configuration.",
  cloud:
    "Target is a fresh cloud VM created by the user's own tofu apply: the wizard generated OpenTofu only and created nothing.",
};

export function buildScaffoldPrompt(
  answers: WizardAnswers,
  baseFiles: Map<string, string>,
  specialCases: string,
): string {
  return [
    "You are the scaffolding builder for an enjoy-the-silence environment. The deterministic wizard already generated the base files below. The user has special cases those templates do not cover.",
    "",
    `Wizard answers: ${JSON.stringify(answers)}`,
    `Deployment context: ${TARGET_CONTEXT[answers.target]}`,
    "",
    `Special cases to cover: ${specialCases}`,
    "",
    "Base files:",
    fileBlock(baseFiles),
    "",
    "Rules: generate files only — never apply, switch, or deploy anything; preserve build-before-switch; secrets only as references to 0600 env files, never values; do not add a telegram integration.",
    'Reply with ONLY a JSON object: {"files": {"<relative path>": "<full new content>"}, "summary": "<one line>"}. Include only files you add or change. No prose outside the JSON.',
  ].join("\n");
}

export function parseAgentFiles(reply: string): {
  files: Map<string, string>;
  summary: string;
} {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("builder agent returned no JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    throw new Error("builder agent returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("builder agent returned invalid JSON");
  const raw = (parsed as Record<string, unknown>).files;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("builder agent returned no files object");
  const files = new Map<string, string>();
  for (const [path, content] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof content !== "string") throw new Error(`builder agent file is not text: ${path}`);
    validateAgentFile(path, content);
    files.set(path, content);
  }
  const summary = (parsed as Record<string, unknown>).summary;
  return {
    files,
    summary: typeof summary === "string" ? summary : "",
  };
}

export function buildQcPrompt(
  specialCases: string,
  files: Map<string, string>,
  builderSummary: string,
): string {
  return [
    "You are the QC reviewer for an enjoy-the-silence scaffold. You are a separate session from the builder; do not trust its summary. The builder was asked to cover these special cases:",
    "",
    specialCases,
    "",
    `Builder summary: ${builderSummary}`,
    "",
    "Resulting files:",
    fileBlock(files),
    "",
    "Check: every special case is covered; nothing is applied/switched/deployed; no secret values (env-file references only); no telegram integration; build-before-switch is preserved.",
    "Reply with first line exactly `QC: PASS` or `QC: VETO`, followed by one-line reasons. Anything else is treated as a veto.",
  ].join("\n");
}

export function parseQcVerdict(reply: string): string {
  const first =
    reply
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  if (first !== "QC: PASS")
    throw new QcVetoError(`QC vetoed the scaffold: ${reply.split("\n")[0] ?? "no verdict"}`);
  return reply.trim();
}

/** Returns null when there are no special cases (agent is never invoked). */
export async function scaffoldWithAgent(opts: {
  answers: WizardAnswers;
  baseFiles: Map<string, string>;
  specialCases: string;
  runBuilder: AgentRunner;
  runQc: AgentRunner;
}): Promise<ScaffoldResult | null> {
  const special = opts.specialCases.trim();
  if (!special) return null;
  const built = parseAgentFiles(
    await opts.runBuilder(buildScaffoldPrompt(opts.answers, opts.baseFiles, special)),
  );
  const files = new Map(opts.baseFiles);
  for (const [path, content] of built.files) files.set(path, content);
  const qcSummary = parseQcVerdict(await opts.runQc(buildQcPrompt(special, files, built.summary)));
  return {
    files,
    changed: [
      ...built.files.keys(),
    ],
    builderSummary: built.summary,
    qcSummary,
  };
}
