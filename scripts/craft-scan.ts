#!/usr/bin/env bun
// Craft scan CLI: the deterministic half of review content checks, run by a
// human or by `verify` calibration. Two modes:
//   --diff <path|->|--base REF   scan a unified diff's ADDED lines (default:
//                                --base HEAD, i.e. everything not yet landed)
//   --audit                      scan the whole tracked tree (new/changed-code
//                                baseline; noisy by definition — that is the
//                                point of running it before arming anything)
//
// Always exits 0: this is evidence for a reviewer, not a gate. The factory
// embeds the same scanners in the reviewer card, where a Band A finding may
// back a CRAFT-GATE veto and a Band B finding is only a shortlist.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { addedCommentHits, formatCommentReport, scanCommentLine } from "../src/crew/comment-scan";
import { addedContentHits, formatContentReport, scanCopyLine } from "../src/crew/content-scan";

const SRC =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|sh|css|scss|html?|md|mdx|vue|svelte|ya?ml|toml|nix)$/;

// Mirrors the factory's probe (dispatch.ts): when anything in this repo
// attaches behaviour at runtime, a control with no handler in the diff is a
// candidate, not a defect — a script can wire it by id or selector, which is
// exactly how our own public/app.js wires its markup.
const RUNTIME_WIRING =
  "addEventListener|cloneElement|Children\\.map|querySelector|\\.onclick|data-action|hx-|x-on:";

function runtimeWiringHere(): boolean {
  try {
    execFileSync(
      "git",
      [
        "rev-parse",
        "--is-inside-work-tree",
      ],
      {
        encoding: "utf8",
      },
    );
  } catch {
    return true; // cannot search: assume wired
  }
  try {
    const out = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "-E",
        RUNTIME_WIRING,
        "--",
        ".",
      ],
      {
        encoding: "utf8",
      },
    );
    return out.trim().length > 0;
  } catch {
    return false; // git grep exits 1 when nothing matched
  }
}

function readDiff(args: string[]): string {
  const target = args[0] ?? "--base";
  if (target === "--base") {
    return execFileSync(
      "git",
      [
        "diff",
        args[1] ?? "HEAD",
      ],
      {
        encoding: "utf8",
      },
    );
  }
  if (target === "-") {
    return readFileSync("/dev/stdin", "utf8");
  }
  return readFileSync(target, "utf8");
}

function reportDiff(diff: string): void {
  const wiring = runtimeWiringHere();
  const comments = addedCommentHits(diff);
  const content = addedContentHits(diff, {
    runtimeWiring: wiring,
  });
  console.log(
    `runtime wiring in this repo: ${wiring ? "present — interactive findings are candidates" : "none — an unwired control is provable"}`,
  );
  console.log("comments:");
  console.log(formatCommentReport(comments, 50));
  console.log("content:");
  console.log(formatContentReport(content, 50));
}

function auditTree(): void {
  const files = execFileSync(
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
  )
    .split("\n")
    .filter((f) => f && SRC.test(f));
  const comments = files.flatMap((file) => {
    const hits = readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => scanCommentLine(line, file, i + 1))
      .filter((h) => h !== null);
    return hits;
  });
  const content = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) => scanCopyLine(line, file, i + 1)),
  );
  console.log(`scanned ${files.length} tracked source file(s)`);
  console.log("comments:");
  console.log(formatCommentReport(comments, 50));
  console.log("content:");
  console.log(formatContentReport(content, 50));
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "--audit") {
    auditTree();
    return;
  }
  reportDiff(readDiff(args[0] === "--diff" ? args.slice(1) : args));
}

main();
