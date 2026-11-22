import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTick, runTaskPipeline } from "./dispatch";
import {
  checkPrereqs,
  consecutiveDeferrals,
  deferralNote,
  ownerOverrideAfter,
  PREREQ_DEFERRAL_LIMIT,
  parseDeferralNote,
  parsePlanPrereqs,
  prereqKey,
  prereqSetKey,
} from "./prereq";
import { FactoryStore } from "./store";
import { approvePlan, draftPlan, newTask } from "./task";

const T0 = "2026-10-22T10:00:00.000Z";

function gitRepo() {
  const base = mkdtempSync(join(tmpdir(), "prereq-"));
  const repo = join(base, "app");
  mkdirSync(repo, {
    recursive: true,
  });
  const git = (args: string) =>
    execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
      cwd: repo,
      encoding: "utf8",
    });
  git("init -q");
  return {
    base,
    repo,
    git,
  };
}

async function setup() {
  const { base, repo, git } = gitRepo();
  await Bun.write(join(repo, "a.txt"), "one\n");
  git("add a.txt");
  git("commit -qm one");
  const store = new FactoryStore(join(base, "store"));
  await store.registerProject("p1", repo);
  const stub = join(base, "stub.ts");
  await Bun.write(
    stub,
    [
      `import { writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `const prompt = process.argv[process.argv.length - 1] ?? "";`,
      `const cwd = process.cwd();`,
      `let text = "built the feature";`,
      `if (prompt.includes("Write the implementation plan")) { writeFileSync(join(cwd, "PLAN-DRAFT.md"), "# Intent\\nDo the thing.\\n## Why\\nNeeded.\\n## Approach\\nSmall steps.\\n## Success criteria\\nbun test passes\\n"); text = "PLAN_WRITTEN"; }`,
      `else if (prompt.includes("Red-team this plan as a subject-matter expert")) text = "PASS sme plan ok\\nArgument: intent is narrow enough to test\\nArgument: approach reuses existing routes";`,
      `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\nArgument: why-now holds, problem is current\\nArgument: no simpler solution was named";`,
      `else if (prompt.includes("Review as a subject-matter expert")) text = "PASS sme ok\\nIntent as I understand it: ship the route\\nArgument: diff matches the plan";`,
      `else if (prompt.includes("Review as a code reviewer")) text = "PASS coder ok\\nArgument: coverage now exists";`,
      `else { writeFileSync(join(cwd, "verification.webm"), "fake-video-bytes"); }`,
      `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-1" }, payload_type: "run.terminal.completed", payload: { text } }));`,
    ].join("\n"),
  );
  return {
    base,
    repo,
    git,
    store,
    stub,
  };
}

function approvedTask(id: string, plan: string) {
  return approvePlan(
    draftPlan(
      newTask(
        {
          id,
          projectId: "p1",
          title: id,
          prompt: `do ${id}`,
        },
        T0,
      ),
      plan,
      T0,
    ),
    T0,
  );
}

async function tick(
  store: FactoryStore,
  opts?: {
    command?: readonly string[];
    maxParallelTasks?: number;
    active?: Set<string>;
  },
) {
  const active = opts?.active ?? new Set<string>();
  const launched = await dispatchTick({
    store,
    command: opts?.command,
    maxParallelTasks: opts?.maxParallelTasks ?? 2,
    ramFloorMb: 0,
    active,
    now: () => T0,
  });
  return {
    launched,
    active,
  };
}

async function settle(store: FactoryStore, active: Set<string>, id: string) {
  for (let i = 0; i < 100 && (await store.readTask(id))?.state !== "done"; i++)
    await Bun.sleep(100);
  expect((await store.readTask(id))?.state).toBe("done");
  for (let i = 0; i < 100 && active.size > 0; i++) await Bun.sleep(100);
}

describe("prereq parse (plan-stated prerequisites)", () => {
  test("no section means no gate", () => {
    const parsed = parsePlanPrereqs("# Intent\nDo the thing.\n");
    expect(parsed.present).toBe(false);
    expect(parsed.items).toEqual([]);
    expect(parsed.malformed).toEqual([]);
  });

  test("commit, symbol, scoped symbol and pending parse", () => {
    const parsed = parsePlanPrereqs(
      [
        "# Intent",
        "Do the thing.",
        "## prerequisites",
        "- commit: f9c86f0",
        "- symbol: planConsistencyGate",
        "- symbol: planConsistencyGate in src/governance/gates.ts",
        "- pending: the predecessor has not landed yet",
      ].join("\n"),
    );
    expect(parsed.present).toBe(true);
    expect(parsed.malformed).toEqual([]);
    expect(parsed.items.map((i) => prereqKey(i))).toEqual([
      "commit:f9c86f0",
      "symbol:planConsistencyGate",
      "symbol:planConsistencyGate in src/governance/gates.ts",
      "pending:the predecessor has not landed yet",
    ]);
  });

  test("the section ends at the next heading", () => {
    const parsed = parsePlanPrereqs(
      [
        "## prerequisites",
        "- commit: abc1234",
        "## Approach",
        "- commit: deadbee",
      ].join("\n"),
    );
    expect(parsed.items.map((i) => prereqKey(i))).toEqual([
      "commit:abc1234",
    ]);
  });

  test("free prose, a bad sha and an empty section are malformed, never silent", () => {
    expect(parsePlanPrereqs("## prerequisites\nWe need f9c86f0 first.\n").malformed.length).toBe(1);
    expect(parsePlanPrereqs("## prerequisites\n- commit: not-a-sha\n").malformed.length).toBe(1);
    expect(parsePlanPrereqs("## prerequisites\n").malformed).toEqual([
      "the section lists no prerequisites",
    ]);
    expect(parsePlanPrereqs("## prerequisites\n- symbol:\n").malformed.length).toBe(1);
  });

  test("missing-set identity is order-insensitive", () => {
    expect(
      prereqSetKey([
        "b",
        "a",
      ]),
    ).toBe(
      prereqSetKey([
        "a",
        "b",
      ]),
    );
    expect(
      prereqSetKey([
        "a",
      ]),
    ).not.toBe(
      prereqSetKey([
        "a",
        "b",
      ]),
    );
  });
});

describe("prereq check (against a base commit)", () => {
  test("commit presence is ancestry, symbol presence is git grep", async () => {
    const { base, repo, git } = gitRepo();
    git("init -q");
    await Bun.write(join(repo, "a.txt"), "one\n");
    git("add a.txt");
    git("commit -qm one");
    const first = git("rev-parse HEAD").trim();
    await Bun.write(join(repo, "b.txt"), "two\n");
    git("add b.txt");
    git("commit -qm two");
    const second = git("rev-parse HEAD").trim();

    const present = parsePlanPrereqs(
      `## prerequisites\n- commit: ${first}\n- symbol: one\n- symbol: one in a.txt\n`,
    ).items;
    expect(checkPrereqs(repo, second, present)).toEqual({
      missing: [],
      unknown: [],
      base: second,
    });
    // An empty base resolves to HEAD, like the tick gate passes it.
    expect(checkPrereqs(repo, "", present).missing).toEqual([]);

    const future = parsePlanPrereqs(`## prerequisites\n- commit: ${second}\n`).items;
    expect(checkPrereqs(repo, first, future).missing).toEqual([
      `commit:${second}`,
    ]);

    const absent = parsePlanPrereqs(
      "## prerequisites\n- commit: deadbee\n- symbol: zzz-nope\n- symbol: one in b.txt\n- pending: the predecessor has not landed\n",
    ).items;
    const checked = checkPrereqs(repo, second, absent);
    expect(checked.missing).toEqual([
      "commit:deadbee",
      "symbol:zzz-nope",
      "symbol:one in b.txt",
      "pending:the predecessor has not landed",
    ]);
    expect(checked.unknown).toEqual([]);

    // A scope file outside the base tree cannot contain the symbol.
    const scoped = parsePlanPrereqs("## prerequisites\n- symbol: one in nope.txt\n").items;
    const scopedCheck = checkPrereqs(repo, second, scoped);
    expect(scopedCheck.missing).toEqual([
      "symbol:one in nope.txt",
    ]);
    expect(scopedCheck.unknown).toEqual([]);

    // An unreadable repo fails open, like the stale-plan gate.
    const unreadable = checkPrereqs(join(base, "missing"), "", present);
    expect(unreadable.base).toBe("");
    expect(unreadable.missing).toEqual([]);
    expect(unreadable.unknown.length).toBe(present.length);
  });
});

describe("prereq deferral notes (read back on the 3rd consecutive deferral)", () => {
  test("a deferral note round-trips its missing set", () => {
    const parsed = parsePlanPrereqs("## prerequisites\n- commit: f9c86f0\n");
    const note = deferralNote(
      parsed.items,
      [
        "commit:f9c86f0",
      ],
      "abc1234",
      "tick check",
    );
    expect(note.startsWith("prereq deferred:")).toBe(true);
    expect(parseDeferralNote(note)).toEqual({
      missing: [
        "commit:f9c86f0",
      ],
      base: "abc1234",
    });
  });

  test("consecutive counting breaks on other notes and restarts on a changed set", () => {
    const a = deferralNote(
      [],
      [
        "commit:aaa1111",
      ],
      "h1",
      "tick check",
    );
    const b = deferralNote(
      [],
      [
        "commit:aaa1111",
      ],
      "h2",
      "tick check",
    );
    const c = deferralNote(
      [],
      [
        "commit:bbb2222",
      ],
      "h2",
      "tick check",
    );
    const prompts = [
      {
        kind: "system",
        text: a,
      },
      {
        kind: "system",
        text: b,
      },
    ];
    expect(
      consecutiveDeferrals(
        prompts,
        prereqSetKey([
          "commit:aaa1111",
        ]),
      ).length,
    ).toBe(2);
    expect(
      consecutiveDeferrals(
        prompts,
        prereqSetKey([
          "commit:bbb2222",
        ]),
      ).length,
    ).toBe(0);
    expect(
      consecutiveDeferrals(
        [
          ...prompts,
          {
            kind: "system",
            text: c,
          },
        ],
        prereqSetKey([
          "commit:bbb2222",
        ]),
      ).length,
    ).toBe(1);
    expect(
      consecutiveDeferrals(
        [
          ...prompts,
          {
            kind: "user",
            text: "anything",
          },
        ],
        prereqSetKey([
          "commit:aaa1111",
        ]),
      ).length,
    ).toBe(0);
  });

  test("an unconsumed reply overrides; a receipt consumes it", () => {
    const deferred = deferralNote(
      [],
      [
        "commit:aaa1111",
      ],
      "h1",
      "tick check",
    );
    expect(ownerOverrideAfter([])).toBe(false);
    expect(
      ownerOverrideAfter([
        {
          kind: "user",
          text: "looks fine, proceed anyway",
        },
      ]),
    ).toBe(true);
    expect(ownerOverrideAfter(consumed(deferred))).toBe(false);
    expect(
      ownerOverrideAfter([
        ...consumed(deferred),
        {
          kind: "user",
          text: "proceed anyway again",
        },
      ]),
    ).toBe(true);
  });
});

describe("prereq override receipts (single use across tick and pipeline)", () => {
  test("the pipeline ignores the tick receipt; a receipt consumes later ticks", () => {
    const deferred = deferralNote(
      [],
      [
        "commit:aaa1111",
      ],
      "h1",
      "tick check",
    );
    const tickReceipt = consumed(deferred);
    expect(ownerOverrideAfter(tickReceipt, true)).toBe(true);
    expect(ownerOverrideAfter(tickReceipt)).toBe(false);
  });
});

function consumed(deferred: string) {
  return [
    {
      kind: "system",
      text: deferred,
    },
    {
      kind: "user",
      text: "proceed anyway",
    },
    {
      kind: "system",
      text: 'prereq override: the owner said "proceed anyway" — skipping once',
    },
  ];
}

describe("tick gate (defer without starting a builder, escalate on the 3rd)", () => {
  test("a missing predecessor defers twice, then blocks with the stored history", async () => {
    const { store } = await setup();
    await store.writeTask(
      approvedTask("t1", "# Intent\nDo it.\n## prerequisites\n- commit: deadbee\n"),
    );
    for (let n = 0; n < 2; n++) {
      const { launched } = await tick(store);
      expect(launched).toEqual([]);
      const task = await store.readTask("t1");
      expect(task?.state).toBe("planned");
      expect(task?.attempts).toBe(0);
    }
    const history = await store.listPrompts("t1");
    expect(history.filter((p) => p.text.startsWith("prereq deferred:")).length).toBe(2);
    expect((await store.listCards("t1")).map((c) => c.id)).not.toContain("builder");

    const { launched } = await tick(store);
    expect(launched).toEqual([]);
    expect((await store.readTask("t1"))?.state).toBe("blocked");
    const notes = await store.listPrompts("t1");
    const blocked = notes.find((p) => p.text.startsWith("prereq blocked:"));
    expect(blocked?.text).toContain("deadbee");
    expect(blocked?.text).toContain(`${PREREQ_DEFERRAL_LIMIT} consecutive deferrals`);
  }, 60_000);

  test("a changed missing set restarts the window instead of escalating", async () => {
    const { store } = await setup();
    await store.writeTask(
      approvedTask("t1", "# Intent\nDo it.\n## prerequisites\n- commit: deadbee\n"),
    );
    await tick(store);
    await tick(store);
    const task = await store.readTask("t1");
    expect(task?.state).toBe("planned");
    if (!task) throw new Error("t1 missing");
    await store.writeTask({
      ...task,
      plan: "# Intent\nDo it.\n## prerequisites\n- symbol: zzz-nope\n",
    });
    const { launched } = await tick(store);
    expect(launched).toEqual([]);
    expect((await store.readTask("t1"))?.state).toBe("planned");
  }, 60_000);

  test("a malformed section blocks immediately with its own signal", async () => {
    const { store } = await setup();
    await store.writeTask(
      approvedTask("t1", "# Intent\nDo it.\n## prerequisites\nWe need deadbee first.\n"),
    );
    const { launched } = await tick(store);
    expect(launched).toEqual([]);
    expect((await store.readTask("t1"))?.state).toBe("blocked");
    const notes = await store.listPrompts("t1");
    expect(notes.some((p) => p.text.startsWith("prereq malformed:"))).toBe(true);
  }, 60_000);

  test("a deferred task yields its slot to the next ready task", async () => {
    const { store, stub } = await setup();
    await store.writeTask(
      approvedTask("twait", "# Intent\nDo it.\n## prerequisites\n- commit: deadbee\n"),
    );
    await store.writeTask(approvedTask("tready", "# Intent\nDo it.\n"));
    const { launched, active } = await tick(store, {
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
    });
    expect(launched).toEqual([
      "tready",
    ]);
    expect((await store.readTask("twait"))?.state).toBe("planned");
    await settle(store, active, "tready");
  }, 120_000);

  test("a present predecessor dispatches like before", async () => {
    const { store, stub, git } = await setup();
    const head = git("rev-parse HEAD").trim();
    await store.writeTask(
      approvedTask("t1", `# Intent\nDo it.\n## prerequisites\n- commit: ${head}\n- symbol: one\n`),
    );
    const { launched, active } = await tick(store, {
      command: [
        "bun",
        stub,
      ],
    });
    expect(launched).toEqual([
      "t1",
    ]);
    await settle(store, active, "t1");
  }, 120_000);

  test("proceed-anyway overrides for one dispatch", async () => {
    const { store, stub } = await setup();
    await store.writeTask(
      approvedTask("t1", "# Intent\nDo it.\n## prerequisites\n- commit: deadbee\n"),
    );
    await tick(store);
    await store.appendPrompt("t1", {
      at: T0,
      kind: "user",
      text: "proceed anyway",
    });
    const first = await tick(store, {
      command: [
        "bun",
        stub,
      ],
    });
    expect(first.launched).toEqual([
      "t1",
    ]);
    await settle(store, first.active, "t1");
  }, 120_000);
});

describe("pipeline gate (re-check against the final base)", () => {
  test("a predecessor missing from the base returns the task to planned with no attempt spent", async () => {
    const { store } = await setup();
    await store.writeTask(
      approvedTask("t1", "# Intent\nDo it.\n## prerequisites\n- commit: deadbee\n"),
    );
    const done = await runTaskPipeline("t1", {
      store,
      now: () => T0,
    });
    expect(done.state).toBe("planned");
    expect(done.attempts).toBe(0);
    expect(done.planState).toBe("approved");
    const notes = await store.listPrompts("t1");
    expect(notes.some((p) => p.text.includes("pipeline re-check"))).toBe(true);
    expect((await store.listCards("t1")).map((c) => c.id)).not.toContain("builder");
  }, 60_000);

  test("a malformed section blocks from the pipeline too", async () => {
    const { store } = await setup();
    await store.writeTask(approvedTask("t1", "# Intent\nDo it.\n## prerequisites\n- commit: zz\n"));
    const done = await runTaskPipeline("t1", {
      store,
      now: () => T0,
    });
    expect(done.state).toBe("blocked");
  }, 60_000);
});
