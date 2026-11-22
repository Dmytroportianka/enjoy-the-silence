import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryStore } from "./store";
import {
  approvalCovers,
  assertOutsideWorktree,
  captureMoments,
  classifyShot,
  comparePngs,
  decodePng,
  encodePng,
  isVisualRelevant,
  parseVisualMoments,
  parseVisualMomentsJson,
  resolveVisualMoments,
  sanitizeShotName,
  type VisualReview,
  visualGateAction,
} from "./visual";

function png(
  width: number,
  height: number,
  rgb: [
    number,
    number,
    number,
  ],
): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return encodePng({
    width,
    height,
    data,
  });
}

describe("parseVisualMoments", () => {
  test("reads name, route, viewport and actions from the plan section", () => {
    const plan =
      "# Plan\n\n## Visual moments\n- home: /\n- Checkout Filled: /checkout @1024x768 | fill:#email=a@b.c | click:#pay | wait:250\n\n## Approach\n- not-a-moment: /nope\n";
    const moments = parseVisualMoments(plan);
    expect(moments).toHaveLength(2);
    expect(moments[0]).toEqual({
      name: "home",
      route: "/",
      viewport: "1280x720",
      actions: [],
    });
    expect(moments[1]?.name).toBe("checkout-filled");
    expect(moments[1]?.viewport).toBe("1024x768");
    expect(moments[1]?.actions).toEqual([
      {
        type: "fill",
        selector: "#email",
        value: "a@b.c",
      },
      {
        type: "click",
        selector: "#pay",
        value: "",
      },
      {
        type: "wait",
        selector: "",
        value: "250",
      },
    ]);
  });
  test("no section means no moments", () => {
    expect(parseVisualMoments("## Approach\n- x: /y")).toEqual([]);
  });
});

describe("moments json + relevance", () => {
  test("parses builder spec and sanitizes names", () => {
    const found = parseVisualMomentsJson(
      JSON.stringify([
        {
          name: "Home Page!",
          route: "/",
          viewport: "800x600",
        },
      ]),
    );
    expect(found[0]?.name).toBe("home-page");
    expect(parseVisualMomentsJson("not json")).toEqual([]);
  });
  test("resolve falls back to visual.moments.json in the worktree", () => {
    const dir = mkdtempSync(join(tmpdir(), "visual-moments-"));
    writeFileSync(
      join(dir, "visual.moments.json"),
      JSON.stringify([
        {
          name: "a",
          route: "/a",
        },
      ]),
    );
    expect(resolveVisualMoments("no moments here", dir)).toHaveLength(1);
    expect(resolveVisualMoments("## Visual moments\n- b: /b", dir)[0]?.name).toBe("b");
  });
  test("ui/css tasks and page files are relevant, backend ts is not", () => {
    expect(isVisualRelevant("ui", [], 0)).toBe(true);
    expect(
      isVisualRelevant(
        "general",
        [
          "src/page.tsx",
        ],
        0,
      ),
    ).toBe(true);
    expect(
      isVisualRelevant(
        "backend",
        [
          "src/api.ts",
        ],
        0,
      ),
    ).toBe(false);
    expect(isVisualRelevant("backend", [], 2)).toBe(true);
  });
});

describe("PNG pixel diff", () => {
  test("identical screenshots are unchanged, different ones are changed with a diff image", () => {
    const a = png(
      4,
      4,
      [
        10,
        20,
        30,
      ],
    );
    const b = png(
      4,
      4,
      [
        10,
        20,
        30,
      ],
    );
    const c = png(
      4,
      4,
      [
        200,
        20,
        30,
      ],
    );
    expect(comparePngs(a, b).diffRatio).toBe(0);
    const diff = comparePngs(a, c);
    expect(diff.diffRatio).toBe(1);
    expect(decodePng(diff.diffPng).data[0]).toBe(255); // red highlight
    expect(
      classifyShot({
        name: "x",
        route: "/",
        viewport: "1280x720",
        baselinePng: a,
        afterPng: b,
      }).shot.status,
    ).toBe("unchanged");
    expect(
      classifyShot({
        name: "x",
        route: "/",
        viewport: "1280x720",
        baselinePng: a,
        afterPng: c,
      }).shot.status,
    ).toBe("changed");
  });
  test("new page (no baseline) and missing-after classify correctly", () => {
    const a = png(
      2,
      2,
      [
        1,
        2,
        3,
      ],
    );
    expect(
      classifyShot({
        name: "x",
        route: "/new",
        viewport: "",
        baselinePng: null,
        afterPng: a,
      }).shot.status,
    ).toBe("new");
    expect(
      classifyShot({
        name: "x",
        route: "/",
        viewport: "",
        baselinePng: a,
        afterPng: null,
      }).shot.status,
    ).toBe("missing-after");
  });
  test("size change counts as changed", () => {
    expect(
      classifyShot({
        name: "x",
        route: "/",
        viewport: "",
        baselinePng: png(
          2,
          2,
          [
            0,
            0,
            0,
          ],
        ),
        afterPng: png(
          3,
          2,
          [
            0,
            0,
            0,
          ],
        ),
      }).shot.status,
    ).toBe("changed");
  });
});

describe("visual gate", () => {
  const review = (status: VisualReview["status"], shots: VisualReview["shots"]): VisualReview => ({
    taskId: "t1",
    status,
    at: "2026-01-01T00:00:00Z",
    baseCommit: "abc",
    threshold: 0.001,
    reason: "",
    shots,
    comments: [],
  });
  test("pending with changes parks, approved hashes pass, unchanged passes", () => {
    const changed = review("pending", [
      {
        name: "home",
        route: "/",
        viewport: "",
        status: "changed",
        diffRatio: 0.5,
        diffPixels: 8,
        totalPixels: 16,
        width: 4,
        height: 4,
        baseline: "",
        after: "",
        diff: "",
        afterHash: "abc",
        error: "",
      },
    ]);
    expect(visualGateAction(changed, []).action).toBe("park");
    expect(
      visualGateAction(changed, [
        "abc",
      ]).action,
    ).toBe("pass");
    expect(
      approvalCovers(changed, [
        "other",
      ]),
    ).toBe(false);
    const clean = review("pending", [
      {
        name: "home",
        route: "/",
        viewport: "",
        status: "unchanged",
        diffRatio: 0,
        diffPixels: 0,
        totalPixels: 16,
        width: 4,
        height: 4,
        baseline: "",
        after: "",
        diff: "",
        afterHash: "abc",
        error: "",
      },
    ]);
    expect(visualGateAction(clean, []).action).toBe("pass");
    expect(visualGateAction(review("error", []), []).action).toBe("park");
  });
});

describe("storage outside git", () => {
  test("output inside a worktree is refused, store dir is accepted", () => {
    expect(() => assertOutsideWorktree("/repo/worktree", "/repo/worktree/shots")).toThrow(
      "outside the git worktree",
    );
    expect(() => assertOutsideWorktree("/repo/worktree", "/data/tasks/t1/visual")).not.toThrow();
    expect(sanitizeShotName("  Checkout: Filled! ")).toBe("checkout-filled");
  });
  test("store keeps review + PNGs under tasks/<id>/visual, readable back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "visual-store-"));
    const store = new FactoryStore(dir);
    const shot = png(
      2,
      2,
      [
        9,
        9,
        9,
      ],
    );
    mkdirSync(join(store.visualDir("task-1"), "after"), {
      recursive: true,
    });
    writeFileSync(join(store.visualDir("task-1"), "after", "home.png"), shot);
    await store.writeVisualReview("task-1", {
      taskId: "task-1",
      status: "pending",
      at: "2026-01-01T00:00:00Z",
      baseCommit: "abc",
      threshold: 0.001,
      reason: "",
      shots: [],
      comments: [],
    });
    expect((await store.readVisualReview("task-1"))?.status).toBe("pending");
    expect(readFileSync(store.visualFilePath("task-1", "after", "home.png")).length).toBe(
      shot.length,
    );
    expect(store.visualFilePath("task-1", "after", "../evil.png")).toBe(
      join(dir, "tasks", "task-1", "visual", "after", "..evil.png"),
    );
  });
  test("capture writes PNGs only to the given outDir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "visual-capture-"));
    const out = join(dir, "out");
    // No server configured: capture must fail loudly, not silently pass.
    await expect(
      captureMoments({
        cwd: dir,
        moments: [
          {
            name: "home",
            route: "/",
            viewport: "1280x720",
            actions: [],
          },
        ],
        outDir: out,
      }),
    ).rejects.toThrow("no base URL");
  });
});
