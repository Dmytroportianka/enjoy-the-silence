#!/usr/bin/env bun
// Suppression audit CLI. Two modes:
//   --audit          scan every tracked source file in the repo for
//                    suppressions without a reason (baseline hygiene); exits 1
//                    when any unexplained suppression exists.
//   --diff <path>    read a unified diff file (or "-" for stdin) and report
//                    the suppressions its added lines carry; exits 1 when any
//                    added suppression is unexplained.
// The factory uses the same scanner inline in the review station; this CLI
// exists so `bun run verify` and humans can run the check standalone.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  addedSuppressionHits,
  formatSuppressionReport,
  type SuppressionHit,
  scanLine,
  unexplainedHits,
} from "../src/crew/review-scan";

const SRC = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go)$/;

function auditTrackedFiles(): boolean {
  // Tracked AND untracked-but-not-ignored: a file the audit has not seen
  // yet is exactly where an unexplained suppression hides — auditing only
  // tracked files let a brand-new file pass the gate until its first commit.
  let files: string[] = [];
  try {
    files = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      {
        encoding: "utf8",
      },
    ).split("\n");
  } catch {
    console.error("suppressions: git ls-files failed — not a git tree?");
    return false;
  }
  const all: SuppressionHit[] = [];
  for (const file of files) {
    if (!file || !SRC.test(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => all.push(...scanLine(line, file, i + 1)));
  }
  const bad = unexplainedHits(all);
  console.log(`suppressions audit: ${all.length} total, ${bad.length} unexplained`);
  for (const h of bad) console.log(`  ${h.file}:${h.line} ${h.marker} (no reason)`);
  return bad.length === 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--diff") {
    const target = args[1];
    if (!target) {
      console.error("usage: bun scripts/suppressions.ts --diff <file|-|--base REF>");
      process.exit(2);
    }
    let diff = "";
    if (target === "-") {
      diff = await Bun.stdin.text();
    } else if (target === "--base") {
      diff = execFileSync(
        "git",
        [
          "diff",
          args[2] ?? "HEAD",
        ],
        {
          encoding: "utf8",
        },
      );
    } else {
      diff = readFileSync(target, "utf8");
    }
    const hits = addedSuppressionHits(diff);
    console.log(formatSuppressionReport(hits, 50));
    process.exit(unexplainedHits(hits).length ? 1 : 0);
  }
  if (args[0] === "--audit") {
    process.exit(auditTrackedFiles() ? 0 : 1);
  }
  console.error("usage: bun scripts/suppressions.ts --audit | --diff <file|-|--base REF>");
  process.exit(2);
}

await main();
