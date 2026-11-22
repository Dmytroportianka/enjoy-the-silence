import { describe, expect, test } from "bun:test";
import { addedLines, stripStrings } from "./diff-walk";

describe("stripStrings", () => {
  test("blanks literal contents but keeps the length", () => {
    const line = 'const a = "// not a comment";';
    expect(stripStrings(line)).not.toContain("not a comment");
    expect(stripStrings(line).length).toBe(line.length);
  });

  test("keeps escapes inside a literal from ending it early", () => {
    expect(stripStrings('x = "a \\" b"; y = 1;')).toContain("y = 1;");
  });
});

describe("addedLines", () => {
  test("maps added lines to file and NEW-side line numbers across hunks", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      "-old",
      " context",
      "+added one",
      "@@ -10,0 +12,1 @@",
      "+added two",
    ].join("\n");
    const lines = addedLines(diff);
    expect(lines.map((l) => l.line)).toEqual([
      2,
      12,
    ]);
    expect(lines.every((l) => l.file === "a.ts")).toBe(true);
    expect(lines[0]?.text).toBe("added one");
  });

  test("headers, deletions and the no-newline marker are not added lines", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1 @@",
      "-removed",
      " context",
      "\\ No newline at end of file",
    ].join("\n");
    expect(addedLines(diff)).toEqual([]);
  });

  test("switching files mid-diff retargets later lines", () => {
    const diff = [
      "+++ b/one.ts",
      "@@ -0,0 +1,1 @@",
      "+a",
      "+++ b/two.ts",
      "@@ -0,0 +1,1 @@",
      "+b",
    ].join("\n");
    expect(addedLines(diff).map((l) => l.file)).toEqual([
      "one.ts",
      "two.ts",
    ]);
  });
});
