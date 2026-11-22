#!/usr/bin/env bun
// Generate static badge images (SVG) for the README and the Pages site
// from real, locally measured state — no shields.io, no external service:
//   ci.svg         latest GitHub CI conclusion for main (gh CLI; falls back
//                  to the local test result when gh is unavailable)
//   coverage.svg   line coverage from `bun test --coverage` (lcov)
//   tests.svg      tests passing / failing from that same run
//   complexity.svg unsuppressed cognitive-complexity violations (Biome,
//                  cap 15 per PATTERNS.md; baseline suppressions excluded)
//   lint.svg       `bun run check` + suppression audit outcome
// Output: site/badges/*.svg (published to GitHub Pages; README links them).
//   bun scripts/gen-badges.ts           measure everything (runs the tests)
//   bun scripts/gen-badges.ts --quick   reuse existing coverage/lcov.info
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outDir = join(root, "site", "badges");
mkdirSync(outDir, {
  recursive: true,
});
const quick = process.argv.includes("--quick");

function run(cmd: string): {
  ok: boolean;
  out: string;
} {
  try {
    return {
      ok: true,
      out: execSync(cmd, {
        cwd: root,
        encoding: "utf8",
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
        maxBuffer: 64 * 1024 * 1024,
      }),
    };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
    };
    return {
      ok: false,
      out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

function badge(label: string, value: string, color: string): string {
  const w = Math.ceil(18 + label.length * 6.4 + value.length * 6.8 + 14);
  const labelW = Math.ceil(10 + label.length * 6.4 + 8);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <rect width="${labelW}" height="20" fill="#3a3f47"/>
  <rect x="${labelW}" width="${w - labelW}" height="20" fill="${color}"/>
  <g fill="#ffffff" font-family="Verdana, Geneva, sans-serif" font-size="11">
    <text x="9" y="14">${label}</text>
    <text x="${labelW + 7}" y="14">${value}</text>
  </g>
</svg>
`;
}

function write(name: string, label: string, value: string, color: string): void {
  writeFileSync(join(outDir, name), badge(label, value, color));
  console.log(`${name}: ${label} = ${value}`);
}

// Tests + coverage (one run produces both the counts and lcov).
let testsPass = 0;
let testsFail = 0;
if (!quick || !existsSync(join(root, "coverage", "lcov.info"))) {
  const test = run("bun test --coverage --coverage-reporter=lcov 2>&1");
  const totals = (out: string, kind: string) =>
    Number(
      [
        ...out.matchAll(new RegExp(`(\\d+) ${kind}`, "g")),
      ].at(-1)?.[1] ?? 0,
    );
  testsPass = totals(test.out, "pass");
  testsFail = totals(test.out, "fail");
} else {
  const test = run("bun test 2>&1");
  const totals = (out: string, kind: string) =>
    Number(
      [
        ...out.matchAll(new RegExp(`(\\d+) ${kind}`, "g")),
      ].at(-1)?.[1] ?? 0,
    );
  testsPass = totals(test.out, "pass");
  testsFail = totals(test.out, "fail");
}

let linePct = 0;
let fnPct = 0;
const lcovPath = join(root, "coverage", "lcov.info");
if (existsSync(lcovPath)) {
  let lf = 0,
    lh = 0,
    fnf = 0,
    fnh = 0;
  for (const line of readFileSync(lcovPath, "utf8").split("\n")) {
    if (line.startsWith("LF:")) lf += Number(line.slice(3)) || 0;
    else if (line.startsWith("LH:")) lh += Number(line.slice(3)) || 0;
    else if (line.startsWith("FNF:")) fnf += Number(line.slice(4)) || 0;
    else if (line.startsWith("FNH:")) fnh += Number(line.slice(4)) || 0;
  }
  linePct = lf ? Math.round((lh / lf) * 1000) / 10 : 0;
  fnPct = fnf ? Math.round((fnh / fnf) * 1000) / 10 : 0;
}

const check = run("bun run check");
const audit = run("bun scripts/suppressions.ts --audit");
const lintOk = check.ok && audit.ok;

const complexity = run(
  "bun x biome lint --only complexity/noExcessiveCognitiveComplexity --only complexity/noExcessiveLinesPerFunction . 2>&1",
);
const violations = (complexity.out.match(/noExcessive/g) ?? []).length;

// CI status for main from GitHub when the CLI can answer; otherwise the
// local suite stands in for it (the badge records what was measured).
let ciValue = testsFail === 0 && testsPass > 0 ? "passing (local)" : "unknown";
let ciColor = testsFail === 0 && testsPass > 0 ? "#2ea44f" : "#9e9e9e";
const gh = run(
  "gh run list --repo Dmytroportianka/enjoy-the-silence --workflow CI --branch main --limit 1 --json conclusion,status --jq .[0].conclusion",
);
if (gh.ok && gh.out.trim()) {
  const conclusion = gh.out.trim();
  ciValue = conclusion === "success" ? "passing" : conclusion;
  ciColor = conclusion === "success" ? "#2ea44f" : conclusion === "failure" ? "#cb2431" : "#dbab09";
}

write("ci.svg", "CI · main", ciValue, ciColor);
write(
  "coverage.svg",
  "coverage",
  `${linePct}% lines · ${fnPct}% funcs`,
  linePct >= 90 ? "#2ea44f" : linePct >= 80 ? "#97ca00" : linePct >= 70 ? "#dfb317" : "#cb2431",
);
write(
  "tests.svg",
  "tests",
  testsFail ? `${testsPass} pass · ${testsFail} fail` : `${testsPass} passing`,
  testsFail ? "#cb2431" : "#2ea44f",
);
write(
  "complexity.svg",
  "complexity (cap 15)",
  violations ? `${violations} violations` : "0 violations",
  violations ? "#cb2431" : "#2ea44f",
);
write(
  "lint.svg",
  "lint + suppressions",
  lintOk ? "clean" : "failing",
  lintOk ? "#2ea44f" : "#cb2431",
);
console.log(`badges written to ${outDir}`);
