import { z } from "zod";

// The expected input: one job card per station. A crewmate is a separate
// process fed exactly this — never an open chat. Zod-parsed at every
// boundary (no `as` on file/JSON data).
export const JobCardSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  role: z.enum([
    "builder",
    "qc",
    "redteam",
    "fixer",
    "planner",
    "sme",
    "coder",
    "outsider",
  ]),
  task: z.string().min(1),
  worktree: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  gates: z.array(z.string()).default([]),
});
export type JobCard = z.infer<typeof JobCardSchema>;

export const DeliveryNoteSchema = z.object({
  stationId: z.string().min(1),
  status: z.enum([
    "done",
    "failed",
    "blocked",
  ]),
  summary: z.string(), // first line: the verdict, for boards and lists
  detail: z.string().default(""), // full reply: the thoughts and arguments behind it
  sessionId: z.string().nullable().default(null),
  artifacts: z.array(z.string()).default([]),
  // Consumption logging: which model ran this station and, when the
  // agent's session log could be read, its cumulative token usage.
  model: z.string().optional(),
  provider: z.string().optional(), // CLI runner that produced this delivery (muse, agy, …)
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  // Cache telemetry: whether the station's context pack and verify run were
  // served from cache. Additive — old deliveries still parse.
  contextPackHit: z.boolean().optional(),
  verifyCacheHit: z.boolean().optional(),
});
export type DeliveryNote = z.infer<typeof DeliveryNoteSchema>;

export function renderPrompt(card: JobCard): string {
  return [
    `WORK ORDER ${card.jobId} / STATION ${card.id} / ROLE ${card.role}`,
    "",
    `Task: ${card.task}`,
    `Worktree (your only cwd): ${card.worktree}`,
    card.constraints.length
      ? `Constraints:\n${card.constraints.map((c) => `- ${c}`).join("\n")}`
      : "Constraints: none",
    card.gates.length ? `Gates armed: ${card.gates.join(", ")}` : "Gates armed: none",
    "",
    "Return one delivery note: status (done|failed|blocked), a one-line summary, and artifact paths. Do not ask questions; if blocked, say why in the summary.",
  ].join("\n");
}
