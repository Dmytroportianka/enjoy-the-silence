#!/usr/bin/env bun
// Muse hook: plan-mode lockout. Reads {writing,hasPlan,trivial} JSON
// on stdin, exits 2 when a non-trivial write has no approved plan.
import { planModeGate } from "../../src/governance/gates";

const raw = await Bun.stdin.text();
const j = JSON.parse(raw) as {
  writing?: boolean;
  hasPlan?: boolean;
  trivial?: boolean;
};
const v = planModeGate(Boolean(j.writing), Boolean(j.hasPlan), Boolean(j.trivial));
if (v.decision === "block") {
  console.error(`plan-mode lockout: ${v.reasons.join("; ")}`);
  process.exit(2);
}
