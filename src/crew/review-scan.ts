// Diff suppression scanner: finds every line a diff ADDS that silences a
// check — disabled lints, type opt-outs, skipped/only tests, per-stack
// ignore markers — and records whether the silence is explained.
//
// Why it exists: agents finish tasks by silencing the complaint instead of
// fixing the code (skip the test, ignore the rule). The reviewer must be
// able to confirm each silence was deliberate, with a reason, instead of
// re-reading the whole diff looking for them. Everything that can be
// checked without an AI reading files should be; this is that check.
//
// Pure and dependency-free so both the factory (dispatch review cards) and
// the CLI (scripts/suppressions.ts) can use it.

import { addedLines, stripStrings } from "./diff-walk";

export type SuppressionKind =
  | "lint-ignore" // the disabled-lint markers: eslint-disable, tslint, noqa, nolint, rust allow
  | "type-optout" // the type opt-outs: ts-expect-error, ts-ignore, ts-nocheck, python type ignore
  | "test-skip" // the skipped-test markers across stacks: JS, pytest, rust, go
  | "test-only"; // test.only / it.only / describe.only / fit / fdescribe — focus leakage

export interface SuppressionHit {
  file: string;
  line: number; // 1-based line number in the NEW file
  kind: SuppressionKind;
  marker: string; // the marker that was matched, e.g. "biome-ignore", "test.skip"
  text: string; // the trimmed added line
  explained: boolean; // does the line carry a reason, not just the marker?
}

interface Pattern {
  re: RegExp;
  kind: SuppressionKind;
  marker: string | ((m: RegExpMatchArray) => string);
  /** Extract whether the silence carries an explanation. */
  explained: (m: RegExpMatchArray, raw: string) => boolean;
}

const PATTERNS: Pattern[] = [
  // JavaScript / TypeScript lint suppressions. biome-ignore carries its
  // reason after the final ":"; eslint-disable requires a "-- reason".
  {
    re: /(?:\/\/|\/\*)\s*biome-ignore(?:\s+(?:lint|assist)\/[\w/-]+)+(\s*:\s*(.*))?\s*\*?\/?$/,
    kind: "lint-ignore",
    marker: "biome-ignore",
    explained: (m) => (m[2] ?? "").trim().length > 0,
  },
  {
    re: /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b([\s\S]*)$/,
    kind: "lint-ignore",
    marker: "eslint-disable",
    explained: (m) => /--\s*\S/.test(m[1] ?? ""),
  },
  {
    re: /\/\/\s*tslint:disable(?:-next-line)?\b([\s\S]*)$/,
    kind: "lint-ignore",
    marker: "tslint:disable",
    explained: (m) => /--\s*\S/.test(m[1] ?? ""),
  },
  // Whole-file TypeScript opt-outs are the loudest: they silence everything.
  {
    re: /@ts-no[c]heck\b(.*)$/,
    kind: "type-optout",
    marker: "@ts-nocheck",
    explained: (m) => /\S/.test(m[1] ?? ""),
  },
  {
    re: /@ts-(?:expect-error|ignore)\b(.*)$/,
    kind: "type-optout",
    marker: (m) => (m[0].startsWith("@ts-expect-error") ? "@ts-expect-error" : "@ts-ignore"),
    explained: (m) => /\S/.test(m[1] ?? ""),
  },
  // Skipped tests.
  {
    re: /\b(?:test|it|describe)\.(skip|todo)\(/,
    kind: "test-skip",
    marker: (m) => m[0].trimStart().split("(")[0] ?? m[0],
    explained: (m) => /\/\/\s*\S|\/\*\s*\S/.test(m.input ?? ""),
  },
  {
    re: /\b(?:xit|xdescribe|xtest)\(/,
    kind: "test-skip",
    marker: (m) => m[0].trimStart().split("(")[0] ?? m[0],
    explained: (m) => /\/\/\s*\S/.test(m.input ?? ""),
  },
  // Focused tests leak: one .only silently disables every other test.
  {
    re: /\b(?:test|it|describe)\.only\(|\b(?:fit|fdescribe)\(/,
    kind: "test-only",
    marker: (m) => m[0].trimStart().split("(")[0] ?? m[0],
    explained: () => false, // no explanation justifies shipping .only; the reviewer removes it
  },
  // Python.
  {
    re: /#\s*noqa(?::\s*[\w,\s]+)?\s*(.*)$/,
    kind: "lint-ignore",
    marker: "noqa",
    explained: (m) => /:\s*[\w,\s]+/.test(m[0]) || /\S/.test(m[1] ?? ""),
  },
  {
    re: /#\s*type:\s*ignore(?:\s*\[[^\]]*\])?\s*(.*)$/,
    kind: "type-optout",
    marker: "type: ignore",
    explained: (m) => /\[[^\]]+\]/.test(m[0]) || /\S/.test(m[1] ?? ""),
  },
  {
    re: /pytest\.mark\.(?:skip|skipif|xfail)\b(.*)$/,
    kind: "test-skip",
    marker: "pytest.mark.skip",
    explained: (m) => /reason\s*=/.test(m[1] ?? ""),
  },
  {
    re: /@unittest\.skip\b(.*)$/,
    kind: "test-skip",
    marker: "unittest.skip",
    explained: (m) => /\(\s*["']/.test(m[1] ?? ""),
  },
  // Rust.
  {
    re: /#\[allow\(([^)]*)\)\]/,
    kind: "lint-ignore",
    marker: "#[allow",
    explained: (m) => (m[1] ?? "").trim().length > 0, // naming the lint is the explanation
  },
  {
    re: /#\[ignore(?:\((.*)\))?\]/,
    kind: "test-skip",
    marker: "#[ignore",
    explained: (m) => /reason\s*=\s*"/.test(m[1] ?? ""),
  },
  // Go.
  {
    re: /\/\/nolint(?::[\w,\s]+)?\s*(.*)$/,
    kind: "lint-ignore",
    marker: "nolint",
    explained: (m) => /:[\w,\s]+/.test(m[0]) || /\S/.test(m[1] ?? ""),
  },
  {
    re: /\bt\.Skip(?:f|Now)?\(/,
    kind: "test-skip",
    marker: "t.Skip",
    explained: (_m, raw) => /t\.Skipf?\(\s*["']/.test(raw), // a message string is the reason
  },
];

/** Scan one line for suppressions; returns all hits on that line. */
export function scanLine(line: string, file = "", lineNo = 0): SuppressionHit[] {
  const hits: SuppressionHit[] = [];
  const bare = stripStrings(line); // markers as data (strings) are not suppressions
  for (const p of PATTERNS) {
    const m = p.re.exec(bare);
    if (!m) continue;
    hits.push({
      file,
      line: lineNo,
      kind: p.kind,
      marker: typeof p.marker === "function" ? p.marker(m) : p.marker,
      text: line.trim(),
      explained: p.explained(m, line),
    });
  }
  return hits;
}

/** Parse a unified diff and return the suppressions its ADDED lines carry. */
export function addedSuppressionHits(diff: string): SuppressionHit[] {
  const hits: SuppressionHit[] = [];
  for (const added of addedLines(diff)) {
    hits.push(...scanLine(added.text, added.file, added.line));
  }
  return hits;
}

/** Unexplained hits — the ones the reviewer must confirm or reject. */
export function unexplainedHits(hits: SuppressionHit[]): SuppressionHit[] {
  return hits.filter((h) => !h.explained);
}

function hitLine(h: SuppressionHit): string {
  return `${h.explained ? "ok" : "??"} ${h.file}:${h.line} ${h.marker}${h.explained ? "" : " (no reason)"}`;
}

/** Compact, review-card-sized report. Never throws. */
export function formatSuppressionReport(hits: SuppressionHit[], maxLines = 30): string {
  if (!hits.length) return "(none)";
  const lines = hits.slice(0, maxLines).map(hitLine);
  const extra = hits.length - maxLines;
  const tail =
    extra > 0
      ? [
          `... ${extra} more suppression(s)`,
        ]
      : [];
  const unexplained = hits.filter((h) => !h.explained).length;
  return [
    `${hits.length} suppression(s) added, ${unexplained} unexplained`,
    ...lines,
    ...tail,
  ].join("\n");
}
