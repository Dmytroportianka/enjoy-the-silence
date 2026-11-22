#!/usr/bin/env bun
// Unattended-run rehearsal: order -> builder (plants fault) -> QC stops the line
// -> fixer reworks -> QC passes -> rollback shown. Offline by default (stub
// crewmates, separate processes, same job-card contract). `--live` uses the
// Muse preset instead and needs a logged-in / API-keyed muse.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStation, watchStation } from "../src/crew/orchestrator";
import { MUSE_PRESET } from "../src/crew/preset";
import { FactoryStore } from "../src/crew/store";

const live = process.argv.includes("--live");
const root = mkdtempSync(join(tmpdir(), "agent-factory-demo-"));
const wt = join(root, "worktree");
await Bun.$`mkdir -p ${wt}`;
const store = new FactoryStore(join(root, "data"));
const jobId = "demo";
const command = live
  ? [
      ...MUSE_PRESET.command,
    ]
  : [
      "bun",
      join(import.meta.dir, "stub-agent.ts"),
    ];
const station = async (id: string, role: "builder" | "qc" | "fixer", task: string) => {
  const card = {
    id,
    jobId,
    role,
    task,
    worktree: wt,
    constraints: [],
    gates: [
      "redteam",
    ],
  };
  await store.writeCard(card);
  // The station's live log streams to the console as it works — the same
  // buffer the control room tailing shows, so the rehearsal doubles as a
  // look at the feature.
  watchStation(id, (out) => out.subscribeParsed((l) => console.log(`  [${id}] ${l.text}`)));
  const note = await runStation(card, {
    store,
    command,
    timeoutMs: 120_000,
  });
  console.log(`[${id}/${role}] ${note.status}: ${note.summary}`);
  return note;
};

console.log("Work order: add hello service and expose it at /hello\n");
const snapshot = "";
await station("builder", "builder", "add hello service and expose it at /hello");
const qc1 = await station("qc", "qc", "verify nginx.conf for hello service");
// A station that delivered its verdict is "done" even on non-zero exit (see
// orchestrator); the verdict itself is the first line of the summary.
if (!qc1.summary.startsWith("QC FAIL"))
  throw new Error("demo broken: QC should catch the planted fault");
console.log("QC stopped the line. Dispatching fixer…");
await station("fixer", "fixer", "fix the QC failure in nginx.conf");
const qc2 = await station("qc2", "qc", "re-verify nginx.conf");
if (!qc2.summary.startsWith("QC PASS")) throw new Error("demo broken: QC should pass after fix");
const fixed = await Bun.file(join(wt, "nginx.conf")).text();
console.log("\nRollback (recall): restoring pre-delivery snapshot…");
await Bun.write(join(wt, "nginx.conf"), snapshot);
console.log(
  snapshot === "" ? "rolled back: nginx.conf removed to pre-delivery state" : "rolled back",
);
await Bun.write(join(wt, "nginx.conf"), fixed);
console.log(
  "\nRun report: hello service built, planted fault caught by QC, fixed, re-verified. Unattended, start to finish.",
);
console.log(`Evidence in ${join(root, "data")} (job cards + delivery notes)`);
