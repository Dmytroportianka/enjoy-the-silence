#!/usr/bin/env bun
// Muse hook: redteam QC. Reads {plan|prompt|command} JSON on stdin,
// exits 2 (block) on veto, 0 otherwise. Wire in .muse/settings.json.
import { redteamGate } from "../../src/governance/gates";

const raw = await Bun.stdin.text();
let text = raw;
try {
  const j = JSON.parse(raw) as Record<string, unknown>;
  text = String(j.plan ?? j.prompt ?? j.command ?? raw);
} catch {}
const v = redteamGate(text);
if (v.decision === "veto") {
  console.error(`redteam veto: ${v.reasons.join("; ")}`);
  process.exit(2);
}
