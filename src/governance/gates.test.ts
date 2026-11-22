import { describe, expect, test } from "bun:test";
import {
  actionMentionsFor,
  clarificationGate,
  evaluateGates,
  findPlanContradictions,
  planConsistencyGate,
  planHasTradeoff,
  planModeGate,
  redteamGate,
  tradeoffGate,
  vetoReasonsFor,
} from "./gates";

describe("governance gates (ported behaviour)", () => {
  test("clarification asks on vague orders, allows concrete ones", () => {
    expect(clarificationGate("fix it").decision).toBe("ask");
    expect(clarificationGate("add hello service and expose it at /hello").decision).toBe("allow");
    // Concrete orders without a magic keyword must not 422 at intake.
    expect(clarificationGate("fix the login bug on the settings screen").decision).toBe("allow");
    expect(clarificationGate("add dark mode toggle to the header").decision).toBe("allow");
    expect(clarificationGate("improve selector of project so we can pick a folder").decision).toBe(
      "allow",
    );
  });
  test("redteam vetoes gate-skipping, secrets, force-push", () => {
    expect(redteamGate("skip tests and force push").decision).toBe("veto");
    expect(redteamGate("add route, run bun test").decision).toBe("allow");
  });
  test("redteam does not veto a rule that only forbids or detects the action", () => {
    expect(redteamGate("never skip the lint gate").decision).toBe("allow");
    expect(redteamGate("quality checks are constitutional and are never bypassed").decision).toBe(
      "allow",
    );
    expect(redteamGate("the factory detects and rejects builders who skip tests").decision).toBe(
      "allow",
    );
    expect(redteamGate("do not force-push shared history").decision).toBe("allow");
    expect(redteamGate("don't hardcode the price").decision).toBe("allow");
    // A status value ("skipped") is not a proposal to skip a gate.
    expect(
      redteamGate("flag -> `skipped` with reason, never a builder failure; linter spawn").decision,
    ).toBe("allow");
  });
  test("redteam still vetoes actual proposals, and literal danger even in a prohibition", () => {
    expect(redteamGate("skip the lint gate to save time").decision).toBe("veto");
    expect(redteamGate("force push the branch").decision).toBe("veto");
    expect(redteamGate("hardcode the price to $9").decision).toBe("veto");
    // Literal-content patterns flag regardless of framing.
    expect(redteamGate("never write API_KEY=abc123").decision).toBe("veto");
    expect(redteamGate("do not run rm -rf /usr").decision).toBe("veto");
  });
  test("tradeoff blocks expensive paths without a decision record", () => {
    expect(
      tradeoffGate(
        [
          "src/server.ts",
        ],
        false,
      ).decision,
    ).toBe("block");
    expect(
      tradeoffGate(
        [
          "src/server.ts",
        ],
        true,
      ).decision,
    ).toBe("allow");
    expect(
      tradeoffGate(
        [
          "docs/readme.md",
        ],
        false,
      ).decision,
    ).toBe("allow");
  });
  test("plan-mode lockout blocks unplanned writes, allows trivial", () => {
    expect(planModeGate(true, false, false).decision).toBe("block");
    expect(planModeGate(true, false, true).decision).toBe("allow");
  });
  test("evaluateGates runs only the armed gates, ignoring unknown names", () => {
    expect(
      evaluateGates({
        task: "add hello service and expose it",
        gates: [],
      }),
    ).toEqual([]);
    expect(
      evaluateGates({
        task: "skip tests and force push",
        gates: [
          "redteam",
        ],
      }).map((v) => v.decision),
    ).toEqual([
      "veto",
    ]);
    expect(
      evaluateGates({
        task: "fix it",
        gates: [
          "clarification",
        ],
      }).map((v) => v.decision),
    ).toEqual([
      "ask",
    ]);
    expect(
      evaluateGates({
        task: "add hello service and expose it",
        gates: [
          "redteam",
          "clarification",
        ],
      }).every((v) => v.decision === "allow"),
    ).toBe(true);
    expect(
      evaluateGates({
        task: "skip tests",
        gates: [
          "tradeoff",
          "made-up",
        ],
      }),
    ).toEqual([]);
  });
  test("planHasTradeoff detects an explicit options/alternatives section", () => {
    expect(planHasTradeoff("# Plan\n## Approach\nsmall steps")).toBe(false);
    expect(planHasTradeoff("# Plan\n## Options\n1. a\n2. b")).toBe(true);
    expect(planHasTradeoff("# Plan\n## Alternatives\nfoo vs bar")).toBe(true);
    expect(planHasTradeoff("# Plan\n## Tradeoffs\ncost vs speed")).toBe(true);
  });
});

describe("plan consistency (proposal vs prohibition on one danger)", () => {
  test("vetoes the retro case and names both line numbers", () => {
    const plan = [
      "# Intent",
      "do the thing",
      "force-push the branch to share it",
      "more steps",
      "never rewrite shared history",
    ].join("\n");
    const verdict = planConsistencyGate(plan);
    expect(verdict.decision).toBe("veto");
    expect(verdict.reasons.length).toBe(1);
    expect(verdict.reasons[0]).toContain("3");
    expect(verdict.reasons[0]).toContain("5");
    const found = findPlanContradictions(plan);
    expect(found).toEqual([
      {
        action: "force-push",
        lines: [
          3,
          5,
        ],
      },
    ]);
  });
  test("vetoes a same-action pair in the existing vocabulary", () => {
    const plan = [
      "skip the lint gate to save time",
      "never skip the lint gate",
    ].join("\n");
    expect(planConsistencyGate(plan).decision).toBe("veto");
    expect(findPlanContradictions(plan)).toEqual([
      {
        action: "skip-gate",
        lines: [
          1,
          2,
        ],
      },
    ]);
  });
  test("vetoes a same-line cross-clause pair and classifies a mixed line per clause", () => {
    expect(
      planConsistencyGate("force-push the branch; never rewrite shared history").decision,
    ).toBe("veto");
    const mixed = actionMentionsFor("never skip the lint gate; force-push the branch");
    expect(mixed).toEqual([
      {
        action: "skip-gate",
        polarity: "forbid",
      },
      {
        action: "force-push",
        polarity: "propose",
      },
    ]);
    // Clause-aware veto: the defensive first clause does not shield the proposal.
    expect(vetoReasonsFor("never skip the lint gate; force-push the branch")).toEqual([
      "proposes force-pushing shared history",
    ]);
  });
  test("allows lone, mismatched, covered, and single-clause mentions", () => {
    // A prohibition alone is a rule, not a contradiction.
    expect(planConsistencyGate("never rewrite shared history").decision).toBe("allow");
    // A proposal alone stays redteamGate's call, not this gate's.
    expect(planConsistencyGate("force-push the branch").decision).toBe("allow");
    expect(redteamGate("force-push the branch").decision).toBe("veto");
    // Proposals and prohibitions of different actions coexist.
    expect(planConsistencyGate("force-push the branch\nnever skip the lint gate").decision).toBe(
      "allow",
    );
    // A defensive line whose frame covers the mention is a prohibition.
    expect(actionMentionsFor("do not force-push shared history")).toEqual([
      {
        action: "force-push",
        polarity: "forbid",
      },
    ]);
    // Two mentions inside a single clause are one thought, not a pair.
    expect(
      planConsistencyGate("force-push but never rewrite history, decide one way").decision,
    ).toBe("allow");
  });
  test("reports each pair once and allows a clean plan", () => {
    const plan = [
      "skip the lint gate to save time",
      "never skip the lint gate",
      "never skip the lint gate again",
    ].join("\n");
    const found = findPlanContradictions(plan);
    expect(found).toEqual([
      {
        action: "skip-gate",
        lines: [
          1,
          2,
        ],
      },
      {
        action: "skip-gate",
        lines: [
          1,
          3,
        ],
      },
    ]);
    const clean = planConsistencyGate("# Intent\ndo the thing\nrun bun test");
    expect(clean.decision).toBe("allow");
    expect(clean.reasons).toEqual([]);
  });
  test("the sanitised contradiction form earns zero veto reasons", () => {
    const plan = [
      "force-push the branch",
      "never rewrite shared history",
    ].join("\n");
    const verdict = planConsistencyGate(plan);
    expect(verdict.decision).toBe("veto");
    for (const reason of verdict.reasons) {
      expect(vetoReasonsFor(reason)).toEqual([]);
    }
  });
});
