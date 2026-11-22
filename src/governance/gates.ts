// Governance gates, ported by behaviour from the reference .pi/extensions.
// Global and constitutional: callers tune thresholds, never whether a gate
// exists. Honest map of where each gate actually runs:
//   - clarification: intake (submit endpoints) AND the card boundary below.
//   - redteam: a cheap first-line veto filter at the card boundary; the REAL
//     red-team is the separate-context reviewers (SME + coder) in the pipeline.
//   - tradeoff: wired at the merge gate in dispatch.ts, where touched paths
//     are concretely known.
//   - plan-mode: a Muse hook (governance/hooks/plan-mode.ts) — a tool-use
//     lockout inside the agent's own process, not visible at the card.
//   - retrospective: the shift log is the retrospective station (runRetro),
//     not a regex gate.

export interface GateVerdict {
  gate: string;
  decision: "allow" | "ask" | "veto" | "block";
  reasons: string[];
}

const VAGUE = /^(fix|improve|update|change|add|make)\s+(it|this|that|stuff|things)\.?$/i;
export function clarificationGate(order: string): GateVerdict {
  const reasons: string[] = [];
  if (order.trim().length < 12) reasons.push("order is too short to specify a deliverable");
  if (VAGUE.test(order.trim()))
    reasons.push("order names no concrete target (service, app, file, route)");
  // No keyword whitelist: concrete orders like "fix the login bug on the
  // settings screen" name no magic noun yet specify a deliverable, and
  // rejecting them (422) read as a routing failure to the operator.
  return {
    gate: "clarification",
    decision: reasons.length ? "ask" : "allow",
    reasons,
  };
}

export const EXPENSIVE_PATHS = [
  "schema",
  "migration",
  "strategy",
  "finance",
  "server",
  "endpoint",
  "auth",
] as const;
export function tradeoffGate(paths: string[], hasDecisionRecord: boolean): GateVerdict {
  const hits = paths.filter((p) => EXPENSIVE_PATHS.some((e) => p.toLowerCase().includes(e)));
  if (hits.length && !hasDecisionRecord) {
    return {
      gate: "tradeoff",
      decision: "block",
      reasons: [
        `expensive path(s) ${hits.join(", ")} need a recorded tradeoff (>=2 options) first`,
      ],
    };
  }
  return {
    gate: "tradeoff",
    decision: "allow",
    reasons: [],
  };
}

/**
 * A plan records a tradeoff when it carries an explicit options/alternatives
 * section — the ">=2 options considered" the tradeoff gate requires.
 */
const TRADEOFF_SECTION = /^##\s+(options|alternatives|trade-?offs?)\b/im;
export function planHasTradeoff(plan: string): boolean {
  return TRADEOFF_SECTION.test(plan);
}

export interface VetoPattern {
  re: RegExp;
  reason: string;
  // proposal: an instruction to DO something dangerous — suppressed when the
  // line is framed as a prohibition or as something the factory detects /
  // rejects (a rule, not a proposal). literal: the dangerous thing's mere
  // presence is the problem (a secret, a destructive command), so it is
  // flagged regardless of the surrounding words.
  kind: "proposal" | "literal";
}

export const GATE_VETO_PATTERNS: VetoPattern[] = [
  // "skip(ping) the <gate>" as a verb phrase — but NOT "skipped" (a status
  // value) and NOT "skip-the-gate" (a hyphenated noun naming the rule).
  {
    re: /\bskip(s|ping)?\b[ \t]+(the[ \t]+)?(lint|test|typecheck|gate)s?\b/i,
    reason: "proposes skipping a quality gate",
    kind: "proposal",
  },
  {
    re: /force.?push/i,
    reason: "proposes force-pushing shared history",
    kind: "proposal",
  },
  {
    re: /(api[_-]?key|token|secret)\s*[:=]\s*\S+/i,
    reason: "embeds a secret value",
    kind: "literal",
  },
  {
    re: /hardcod.*(price|\$ ?\d)/i,
    reason: "hardcodes a price/value fallback",
    kind: "proposal",
  },
  {
    re: /--no-verify|SKIP_PRE_PUSH/i,
    reason: "proposes bypassing the pre-push gauntlet",
    kind: "proposal",
  },
  {
    re: /rm -rf \/(?!tmp)/,
    reason: "proposes a destructive filesystem operation outside /tmp",
    kind: "literal",
  },
];

/**
 * A line that only forbids a dangerous action, or describes the factory
 * detecting/rejecting it, is a rule — not a proposal. The gate exists to
 * catch an agent being told to DO the thing, so these frames suppress a
 * proposal veto: "never skip the lint gate" is a constraint, "skip the lint
 * gate" is a proposal. Literal-content patterns (secrets, `rm -rf /`) ignore
 * this — their presence in a card is the problem whatever the words say.
 */
const DEFENSIVE_FRAME =
  /\b(never|must not|mustn'?t|do not|don'?t|cannot|can'?t|should not|shouldn'?t|not allowed|not permitted|prohibit|prohibited|forbid|forbidden|banned|disallow|disallowed|constitutional|detect(s|ed|ing)?|reject(s|ed|ing)?|veto(es|ed|ing)?|anti-?gaming|anti-?pattern)\b/i;

/**
 * The veto reasons a single line earns, or none when it is clean: either it
 * matches no pattern, or it only describes/forbids the action (defensive
 * frame) and is therefore not a proposal. Shared by the gate (verdict) and
 * the card boundary sanitizer (which strips only real proposals).
 */
export function vetoReasonsFor(line: string): string[] {
  const reasons = new Set<string>();
  for (const clause of splitPlanClauses(line)) {
    for (const p of GATE_VETO_PATTERNS) {
      if (!p.re.test(clause)) continue;
      if (p.kind === "proposal" && DEFENSIVE_FRAME.test(clause)) continue;
      reasons.add(p.reason);
    }
  }
  return [
    ...reasons,
  ];
}

/**
 * Clauses are the unit a proposal/prohibition lives in: a line split on
 * semicolons and sentence boundaries. Two mentions in one clause are one
 * thought (no contradiction); two clauses — even on one line — can
 * contradict. Splitting on "." only at a sentence boundary keeps paths
 * like decisions.md and flags like --no-verify intact.
 */
export function splitPlanClauses(line: string): string[] {
  const out: string[] = [];
  for (const part of line.split(";")) {
    for (const sentence of part.split(/(?<=[.!?])\s+/)) {
      const trimmed = sentence.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out.length
    ? out
    : [
        line,
      ];
}

export type ActionPolarity = "propose" | "forbid";

export interface ActionMention {
  action: string;
  polarity: ActionPolarity;
}

interface CanonicalAction {
  id: string;
  mentions: RegExp[];
}

// Closed set of proposal-kind dangers the consistency check compares.
// Literal-content dangers (secrets, rm -rf /) are excluded: their mere
// presence is the problem whatever the words say, so a prohibition of
// them is still a veto and never half of a contradiction pair.
const PLAN_CONTRADICTION_ACTIONS: CanonicalAction[] = [
  {
    id: "force-push",
    mentions: [
      /force.?push/i,
      /rewrit\w*\s+(shared\s+)?history/i,
    ],
  },
  {
    id: "skip-gate",
    mentions: [
      /\bskip(s|ping)?\b[ \t]+(the[ \t]+)?(lint|test|typecheck|gate)s?\b/i,
    ],
  },
  {
    id: "bypass-gauntlet",
    mentions: [
      /--no-verify/i,
      /SKIP_PRE_PUSH/,
      /bypass\w*\s+(the\s+)?(pre.?push|gauntlet)/i,
    ],
  },
  {
    id: "hardcode-price",
    mentions: [
      /hardcod.*(price|\$ ?\d)/i,
    ],
  },
];

/**
 * Every canonical-danger mention in one line, each classified by its own
 * clause: a clause carrying a defensive frame (never, must not, do not,
 * prohibited, ...) forbids the action, any other clause proposes it.
 */
export function actionMentionsFor(line: string): ActionMention[] {
  const mentions: ActionMention[] = [];
  for (const clause of splitPlanClauses(line)) {
    const forbids = DEFENSIVE_FRAME.test(clause);
    for (const action of PLAN_CONTRADICTION_ACTIONS) {
      if (action.mentions.some((re) => re.test(clause))) {
        mentions.push({
          action: action.id,
          polarity: forbids ? "forbid" : "propose",
        });
      }
    }
  }
  return mentions;
}

export interface PlanContradiction {
  action: string;
  lines: [
    number,
    number,
  ];
}

/**
 * Line pairs in a plan that contradict on one canonical danger: one
 * clause proposes the action, another clause (same line with a clause
 * break, or another line) forbids it. Two mentions in a single clause
 * are one thought and never contradict. Each pair is reported once, in
 * first-seen order. Sanitised: action id plus line numbers only, never
 * clause text — so the form itself earns zero vetoReasonsFor reasons
 * (every reason carries "prohibited", the defensive frame that
 * suppresses the proposal patterns it names).
 */
interface PlacedMention {
  action: string;
  line: number;
  clause: number;
}

/** Every canonical-danger mention in a plan, placed by line and clause. */
function collectPlanMentions(plan: string): {
  proposes: PlacedMention[];
  forbids: PlacedMention[];
} {
  const proposes: PlacedMention[] = [];
  const forbids: PlacedMention[] = [];
  plan.split(/\r?\n/).forEach((text, idx) => {
    const lineNo = idx + 1;
    splitPlanClauses(text).forEach((clause, clauseIdx) => {
      const forbidding = DEFENSIVE_FRAME.test(clause);
      for (const action of PLAN_CONTRADICTION_ACTIONS) {
        if (!action.mentions.some((re) => re.test(clause))) continue;
        (forbidding ? forbids : proposes).push({
          action: action.id,
          line: lineNo,
          clause: clauseIdx,
        });
      }
    });
  });
  return {
    proposes,
    forbids,
  };
}

/** Ordered line pair for two mentions of one action. */
function orderedPairLines(
  p: PlacedMention,
  f: PlacedMention,
): [
  number,
  number,
] {
  return p.line <= f.line
    ? [
        p.line,
        f.line,
      ]
    : [
        f.line,
        p.line,
      ];
}

export function findPlanContradictions(plan: string): PlanContradiction[] {
  const { proposes, forbids } = collectPlanMentions(plan);
  const seen = new Set<string>();
  const out: PlanContradiction[] = [];
  for (const p of proposes) {
    for (const f of forbids) {
      if (p.action !== f.action) continue;
      // Same clause, same line: one thought, not a contradiction.
      if (p.line === f.line && p.clause === f.clause) continue;
      const lines = orderedPairLines(p, f);
      const key = `${p.action}:${lines[0]}:${lines[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        action: p.action,
        lines,
      });
    }
  }
  return out;
}

/**
 * Planning-stage consistency gate: vetoes a draft plan when one clause
 * proposes an action another clause forbids for the same canonical
 * danger. A lone proposal or a lone prohibition is NOT this gate's call
 * (a single-line danger stays redteamGate's verdict); only the pair is.
 */
export function planConsistencyGate(plan: string): GateVerdict {
  const contradictions = findPlanContradictions(plan);
  if (!contradictions.length) {
    return {
      gate: "plan-consistency",
      decision: "allow",
      reasons: [],
    };
  }
  return {
    gate: "plan-consistency",
    decision: "veto",
    reasons: contradictions.map(
      (c) =>
        `plan contradiction on ${c.action}: lines ${c.lines[0]} and ${c.lines[1]} (prohibited vs proposed — fix at authoring)`,
    ),
  };
}

/**
 * A cheap first-line filter, NOT the real red-team: it catches only literal
 * phrasings of obviously dangerous intent, and is trivially reworded around.
 * The real red-team is the separate-context reviewers whose PASS/REJECT
 * verdict gates the work; treat this as a spelling check, not a guarantee.
 * It now distinguishes a proposal from a rule (a line that only forbids or
 * detects the action is not vetoed), but it is still a spelling check.
 */
export function redteamGate(plan: string): GateVerdict {
  const reasons = new Set<string>();
  for (const line of plan.split(/\r?\n/)) {
    for (const r of vetoReasonsFor(line)) reasons.add(r);
  }
  return {
    gate: "redteam",
    decision: reasons.size ? "veto" : "allow",
    reasons: [
      ...reasons,
    ],
  };
}

export function planModeGate(writing: boolean, hasPlan: boolean, trivial: boolean): GateVerdict {
  if (writing && !hasPlan && !trivial) {
    return {
      gate: "plan-mode",
      decision: "block",
      reasons: [
        "write attempted without an approved plan (lockout/tagout)",
      ],
    };
  }
  return {
    gate: "plan-mode",
    decision: "allow",
    reasons: [],
  };
}

/**
 * Evaluate the gates a job card arms, against the card's own task text —
 * the one thing always present at the card boundary. Unknown gate names are
 * ignored (the enforceable set is closed). The plan-mode and tradeoff gates
 * are not armed here: they run where their inputs exist (Muse hook, merge
 * gate respectively).
 */
export function evaluateGates(card: { task: string; gates: string[] }): GateVerdict[] {
  const verdicts: GateVerdict[] = [];
  for (const gate of card.gates) {
    if (gate === "redteam") verdicts.push(redteamGate(card.task));
    else if (gate === "clarification") verdicts.push(clarificationGate(card.task));
  }
  return verdicts;
}
