#!/usr/bin/env bun
// Muse hook: clarification intake. Reads {order|prompt} JSON on stdin,
// exits 2 with the missing-spec reasons when the order is underspecified.
import { clarificationGate } from "../../src/governance/gates";

const raw = await Bun.stdin.text();
let text = raw;
try {
  const j = JSON.parse(raw) as Record<string, unknown>;
  text = String(j.order ?? j.prompt ?? raw);
} catch {}
const v = clarificationGate(text);
if (v.decision === "ask") {
  console.error(`clarification needed: ${v.reasons.join("; ")}`);
  process.exit(2);
}
