import { describe, expect, test } from "bun:test";
import {
  addedSuppressionHits,
  formatSuppressionReport,
  scanLine,
  unexplainedHits,
} from "./review-scan";

const DIFF = (body: string) =>
  [
    "diff --git a/x.ts b/x.ts",
    "index 0000000..1111111 100644",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,0 +1,7 @@",
    ...body.split("\n").map((l) => `+${l}`),
  ].join("\n");

describe("scanLine", () => {
  test("biome-ignore with a reason is explained", () => {
    const [h] = scanLine(
      "// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: split when touched",
      "x.ts",
      3,
    );
    expect(h).toBeDefined();
    expect(h?.kind).toBe("lint-ignore");
    expect(h?.marker).toBe("biome-ignore");
    expect(h?.explained).toBe(true);
  });

  test("biome-ignore without a reason is unexplained", () => {
    const [h] = scanLine("// biome-ignore lint/suspicious/noExplicitAny");
    expect(h?.explained).toBe(false);
  });

  test("eslint-disable needs a -- reason", () => {
    expect(scanLine("// eslint-disable-next-line react-hooks/exhaustive-deps")[0]?.explained).toBe(
      false,
    );
    expect(
      scanLine(
        "// eslint-disable-next-line react-hooks/exhaustive-deps -- derived key, not identity",
      )[0]?.explained,
    ).toBe(true);
  });

  test("@ts-expect-error needs a comment reason", () => {
    expect(scanLine("// @ts-expect-error")[0]?.explained).toBe(false);
    expect(scanLine("// @ts-expect-error invalid enum value in test")[0]?.explained).toBe(true);
  });

  test("skipped tests are flagged; a trailing comment explains them", () => {
    expect(scanLine('test.skip("flaky under CI")')[0]?.kind).toBe("test-skip");
    expect(scanLine('test.skip("flaky under CI")')[0]?.explained).toBe(false);
    expect(
      scanLine('it.skip("needs network", () => {}) // waits on the fixture')[0]?.explained,
    ).toBe(true);
  });

  test(".only is always unexplained — nothing justifies focus leakage", () => {
    const [h] = scanLine('test.only("one test")');
    expect(h?.kind).toBe("test-only");
    expect(h?.explained).toBe(false);
  });

  test("python, rust and go markers", () => {
    expect(scanLine("# noqa: E501")[0]?.explained).toBe(true);
    expect(scanLine("# noqa")[0]?.explained).toBe(false);
    expect(scanLine("#[allow(dead_code)]")[0]?.explained).toBe(true);
    expect(scanLine("#[ignore]")[0]?.explained).toBe(false);
    expect(scanLine('#[ignore(reason = "flaky")]')[0]?.explained).toBe(true);
    expect(scanLine("//nolint:errcheck")[0]?.explained).toBe(true);
  });

  test("plain code lines produce no hits", () => {
    expect(scanLine("const x = 1;")).toEqual([]);
    expect(scanLine("if (a) { doThing(); }")).toEqual([]);
  });

  test("markers inside string literals are data, not suppressions", () => {
    expect(scanLine('const s = "// eslint-disable-next-line no-console";')).toEqual([]);
    expect(scanLine("const doc = `biome-ignore lint/a/b: never in a template`;")).toEqual([]);
    expect(scanLine('call("test.skip(\\"flaky\\")")')).toEqual([]);
  });

  test("biome-ignore covers assist actions and block comments", () => {
    expect(
      scanLine("// biome-ignore assist/source/organizeImports: keep import order")[0]?.explained,
    ).toBe(true);
    expect(scanLine("/* eslint-disable no-console */")[0]?.kind).toBe("lint-ignore");
    expect(
      scanLine("/* biome-ignore lint/suspicious/noExplicitAny: boundary */")[0]?.explained,
    ).toBe(true);
  });

  test("pytest skipif and go t.Skip treat their message as the reason", () => {
    expect(
      scanLine('@pytest.mark.skipif(sys.platform == "win32", reason="windows only")')[0]?.explained,
    ).toBe(true);
    expect(scanLine("@pytest.mark.skipif(cond)")[0]?.explained).toBe(false);
    expect(scanLine('\tt.Skip("needs the hardware dongle")')[0]?.explained).toBe(true);
    expect(scanLine("t.Skip()")[0]?.explained).toBe(false);
  });
});

describe("addedSuppressionHits", () => {
  test("tracks the file and the NEW-side line number across hunks", () => {
    const hits = addedSuppressionHits(DIFF("const ok = 1;\n// biome-ignore lint/x/y"));
    expect(hits.length).toBe(1);
    expect(hits[0]?.file).toBe("x.ts");
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.explained).toBe(false);
  });

  test("deleted suppressions are not reported", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1 @@",
      "-// eslint-disable-next-line no-console",
      ' console.log("kept")',
    ].join("\n");
    expect(addedSuppressionHits(diff)).toEqual([]);
  });

  test("git's no-newline marker is not a context line", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1,3 @@",
      "+const a = 1;",
      "+\\ No newline at end of file",
      "+// biome-ignore lint/a/b",
    ].join("\n");
    const hits = addedSuppressionHits(diff);
    expect(hits.length).toBe(1);
    expect(hits[0]?.line).toBe(3);
  });
});

describe("formatSuppressionReport", () => {
  test("summarizes and marks unexplained entries", () => {
    const report = formatSuppressionReport([
      {
        file: "a.ts",
        line: 1,
        kind: "lint-ignore",
        marker: "biome-ignore",
        text: "",
        explained: true,
      },
      {
        file: "b.ts",
        line: 2,
        kind: "test-skip",
        marker: "test.skip",
        text: "",
        explained: false,
      },
    ]);
    expect(report).toContain("2 suppression(s) added, 1 unexplained");
    expect(report).toContain("?? b.ts:2 test.skip (no reason)");
  });

  test("empty input reads as none", () => {
    expect(formatSuppressionReport([])).toBe("(none)");
  });
});

describe("unexplainedHits", () => {
  test("filters to unexplained only", () => {
    const hits = [
      {
        file: "a.ts",
        line: 1,
        kind: "lint-ignore" as const,
        marker: "x",
        text: "",
        explained: true,
      },
      {
        file: "b.ts",
        line: 2,
        kind: "test-skip" as const,
        marker: "x",
        text: "",
        explained: false,
      },
    ];
    expect(unexplainedHits(hits).length).toBe(1);
  });
});
