#!/usr/bin/env bun
import { clarificationGate } from "../governance/gates";
// Crew CLI: submit + reconcile from the terminal (dashboard is optional).
//   bun run crew submit "add hello service and expose it at /hello"
//   bun run crew reconcile demo
import { FactoryStore } from "./store";

const dataDir = process.env.FACTORY_DATA ?? "factory-data";
const store = new FactoryStore(dataDir);
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "submit") {
  const order = rest.join(" ");
  const v = clarificationGate(order);
  if (v.decision === "ask") {
    console.error(`clarification needed: ${v.reasons.join("; ")}`);
    process.exit(2);
  }
  const jobId = process.env.JOB_ID ?? `job-${Date.now()}`;
  await store.writeCard({
    id: "builder",
    jobId,
    role: "builder",
    task: order,
    worktree: process.cwd(),
    constraints: [],
    gates: [
      "redteam",
    ],
  });
  await store.writeCard({
    id: "qc",
    jobId,
    role: "qc",
    task: `Review builder output for: ${order}`,
    worktree: process.cwd(),
    constraints: [
      "different context from builder",
    ],
    gates: [
      "redteam",
    ],
  });
  console.log(`queued ${jobId}: builder, qc (cards in ${dataDir}/jobs/${jobId})`);
} else if (cmd === "reconcile") {
  const jobId = rest[0] ?? "demo";
  const r = await store.reconcile(jobId);
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log("usage: crew submit <order> | crew reconcile <jobId>");
}
