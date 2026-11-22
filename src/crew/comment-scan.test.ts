import { describe, expect, test } from "bun:test";
import { addedCommentHits, formatCommentReport, scanCommentLine } from "./comment-scan";

const DIFF = (path: string, body: string) =>
  [
    `diff --git a/${path} b/${path}`,
    "--- a/x",
    `+++ b/${path}`,
    "@@ -1,0 +1,20 @@",
    ...body.split("\n").map((l) => `+${l}`),
  ].join("\n");

describe("scanCommentLine", () => {
  test("decorative separators and labelled banners are banners", () => {
    expect(scanCommentLine("// ===== AUTH =====", "a.ts")?.kind).toBe("banner");
    expect(scanCommentLine("/* ---- ROUTES ---- */", "a.ts")?.kind).toBe("banner");
    expect(scanCommentLine("# ---------- packages ----------", "flake.nix")?.kind).toBe("banner");
    expect(scanCommentLine("// MAIN LOGIC", "a.ts")?.kind).toBe("banner");
  });

  test("a sentence that happens to start with a caps word is not a banner", () => {
    expect(scanCommentLine("// CORS preflight only runs for POST requests", "a.ts")).toBeNull();
    expect(scanCommentLine("// NOTE", "a.ts")).toBeNull();
  });

  test("workflow narration is flagged", () => {
    expect(scanCommentLine("// Step 1: validate the header", "a.ts")?.kind).toBe("narration");
    expect(scanCommentLine("// First, parse the payload", "a.ts")?.kind).toBe("narration");
    expect(scanCommentLine("// Finally, write the receipt", "a.ts")?.kind).toBe("narration");
  });

  test("empty labels are flagged, real labels are not", () => {
    expect(scanCommentLine("// Main logic", "a.ts")?.kind).toBe("empty-label");
    expect(scanCommentLine("// Helper function", "a.ts")?.kind).toBe("empty-label");
    expect(scanCommentLine("// Error handling", "a.ts")?.kind).toBe("empty-label");
    expect(scanCommentLine("// Retries only on 5xx; 4xx is the caller's bug", "a.ts")).toBeNull();
  });

  test("a vague TODO is flagged, an actionable one is kept", () => {
    expect(scanCommentLine("// TODO: improve this", "a.ts")?.kind).toBe("vague-todo");
    expect(scanCommentLine("// TODO", "a.ts")?.kind).toBe("vague-todo");
    expect(scanCommentLine("// FIXME: handle edge cases", "a.ts")?.kind).toBe("vague-todo");
    expect(scanCommentLine("// TODO: retry on 429 after the backoff window", "a.ts")).toBeNull();
  });

  test("decorative emoji is flagged", () => {
    expect(scanCommentLine("// ✅ Validation", "a.ts")?.kind).toBe("emoji");
    expect(scanCommentLine("# 🚀 Deploy", "deploy.sh")?.kind).toBe("emoji");
  });

  test("end markers are flagged only at the end of a line", () => {
    expect(scanCommentLine("} // end if", "a.ts")?.kind).toBe("end-marker");
    expect(scanCommentLine("# End of function", "a.py")?.kind).toBe("end-marker");
    expect(scanCommentLine("// close the socket after the handshake", "a.ts")).toBeNull();
  });

  test("markers inside strings are data, not comments", () => {
    expect(scanCommentLine('const doc = "// ===== AUTH =====";', "a.ts")).toBeNull();
    expect(scanCommentLine("const label = '// TODO: improve this';", "a.ts")).toBeNull();
  });

  test("plain code and non-comment lines produce nothing", () => {
    expect(scanCommentLine("const x = 1;", "a.ts")).toBeNull();
    expect(scanCommentLine("#count = 0;", "a.ts")).toBeNull();
    expect(scanCommentLine("#!/usr/bin/env bash", "run.sh")).toBeNull();
  });

  test("a markdown heading is a heading, not a comment", () => {
    expect(scanCommentLine("# Setup", "README.md")).toBeNull();
    expect(scanCommentLine("<!-- ===== AUTH ===== -->", "index.html")?.kind).toBe("banner");
  });

  test("per-language comment syntax: python, sql and block continuations", () => {
    expect(scanCommentLine("# Main logic", "worker.py")?.kind).toBe("empty-label");
    expect(scanCommentLine("-- ===== TABLES =====", "dump.sql")?.kind).toBe("banner");
    expect(scanCommentLine(" * Empty label", "a.ts")).toBeNull();
  });
});

describe("addedCommentHits", () => {
  test("reports file and NEW-side line numbers", () => {
    const hits = addedCommentHits(DIFF("src/a.ts", "const ok = 1;\n// ===== AUTH ====="));
    expect(hits.length).toBe(1);
    expect(hits[0]?.file).toBe("src/a.ts");
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.kind).toBe("banner");
  });

  test("deleted and context lines carry no finding", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-// ===== AUTH =====",
      " // ===== KEPT =====",
      "+const x = 1;",
    ].join("\n");
    expect(addedCommentHits(diff)).toEqual([]);
  });
});

describe("formatCommentReport", () => {
  test("summarizes by kind and quotes the line", () => {
    const report = formatCommentReport([
      {
        file: "a.ts",
        line: 1,
        kind: "banner",
        text: "// ===== AUTH =====",
      },
      {
        file: "a.ts",
        line: 4,
        kind: "vague-todo",
        text: "// TODO",
      },
    ]);
    expect(report).toContain("2 comment finding(s) added: 1 banner, 1 vague-todo");
    expect(report).toContain("a.ts:1 banner");
  });

  test("empty input reads as none", () => {
    expect(formatCommentReport([])).toBe("(none)");
  });

  test("long input is capped and says how many it hid", () => {
    const hits = Array.from(
      {
        length: 5,
      },
      (_unused, i) => ({
        file: "a.ts",
        line: i + 1,
        kind: "banner" as const,
        text: "// ===== X =====",
      }),
    );
    expect(formatCommentReport(hits, 2)).toContain("... 3 more comment finding(s)");
  });
});
