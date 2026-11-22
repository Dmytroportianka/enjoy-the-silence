# Demo video script — enjoy-the-silence

**Format:** ~3 min, 16:9, screen recording + voiceover. Two windows only:
terminal (left) and the control room at `http://localhost:4319` (right).
**One-line promise (say it twice, open and close):** *"Give the factory one
sentence, and it manufactures the work, unattended."*
**Audience:** a solo maintainer deciding in 10 seconds whether to clone it.

## Pre-flight (do not record this part)

- [ ] `bun install && bun test && bun run typecheck` — all green.
- [ ] `bun run demo` — ends with the Run report line. If it doesn't,
      stop; the hero scene (Scene 4) is this command.
- [ ] `bun run dashboard` running; open the control room before recording.
- [ ] Terminal font ≥ 16pt, browser zoom 125–150%, dark theme everywhere.
- [ ] No tokens, keys, or real hostnames on screen. The `muse login` step
      is the owner's, by hand — never type a secret on camera.
- [ ] Paste commands from this script instead of typing them live.

## Scene 1 — Hook: the factory already worked (0:00–0:20)

- **Screen:** control room, floor view with finished work visible.
- **Say:** "This is a software factory that starts itself. Clone the
  template, run one wizard, and a governed AI crew goes online — ready to
  take work orders. Watch what happens when I give it one sentence."

## Scene 2 — One sentence in (0:20–0:45)

- **Screen:** dashboard → New task. Prompt (paste it):
  `add a hello service and expose it at /hello`
- **Do:** show the plan pipeline lighting up — Planner → SME red-team →
  Outsider → Reviser — then click **Approve plan & queue**.
- **Say:** "One sentence becomes a work order. A planner drafts the plan,
  and two separate red-teamers attack it before any code is written. I
  approve the plan; the factory queues the job."
- **Overlay:** `Plan first. Two red-teams. Owner approves.`

## Scene 3 — It commissions itself, safely (0:45–1:10)

- **Screen:** terminal.
- **Type:** `bun run wizard -- --target incus --brain muse --out ./my-env`
  then `ls ./my-env`
- **Say:** "This wizard poured the whole base: a reproducible NixOS system,
  its own Gitea, the crew, the control room. And it only *generates* — it
  never applies anything. Applying a config, logging in, entering a key:
  those stay mine. The owner turns the key."
- **Overlay:** `Generates. Never applies.`

## Scene 4 — Hero: QC stops the line (1:10–2:00)

- **Screen:** terminal, full width. This is the scene the video is for.
- **Type:** `bun run demo`
- **Do:** let it play untouched. Builder writes `nginx.conf` with a planted
  fault → `QC FAIL: missing semicolon after listen 8080` → fixer reworks →
  `QC PASS` → rollback shown → Run report.
- **Say (over the QC FAIL line, pause before it lands):** "The builder just
  shipped a broken config. But the builder never grades its own work — QC
  is a *separate session*, with a different context. It stops the line. A
  fixer reworks it, QC re-verifies… and if I ever need it, the delivery
  rolls back. Then the run report tells me what happened."
- **Overlay:** `Builder ≠ QC. Different process. Different context.`

## Scene 5 — The control room (2:00–2:30)

- **Screen:** dashboard → open the running task.
- **Do, in order:** task-page **Now** bar (live station, model, elapsed,
  last edit) → click **Now** to show the exact command and prompt the agent
  is running → **Stations** and **Latest diff** accordions → **Requests**
  view ("the agent asks…") → Settings push notifications toggle.
- **Say:** "I don't watch tmux panes. The control room shows every station
  live — what it's running, how long, what it last touched. When a station
  needs a decision, it asks me here, or pings my phone. It owns no state;
  every state is a file I can read."
- **Overlay:** `No hidden state. Every job card is a file in /data.`

## Scene 6 — Governance you can point at (2:30–2:50)

- **Screen:** terminal, `ls governance/hooks/` (clarification, plan-mode,
  redteam), then briefly `scripts/mirror-out.sh`.
- **Say:** "The guardrails are code, not vibes: clarification intake,
  plan-mode lockout, a red-team line-stop. Same hooks everywhere; a repo can
  only tune how strict. And the factory stores itself in its own Gitea,
  mirrored out — so it's never the only copy of itself."
- **Overlay:** `Guardrails are hooks. Not prompts.`

## Scene 7 — Proof and close (2:50–3:10)

- **Screen:** terminal: `bun test && bun run typecheck` green. Cut to
  [START_WITH_MUSE.md](../START_WITH_MUSE.md).
- **Say:** "Green tests, green types. To start yours, paste one prompt into
  a Muse session and let it commission the factory — it stops at
  every step that must stay human. Give it one sentence. Read the
  run report when it lands. Unattended, start to finish."
- **End card:** repo URL + `bun run demo` + the one-line promise.

## Capture notes

- Record Scenes 3, 4, 7 (terminal) and 1, 2, 5 (browser) as separate takes;
  cut on the overlays, never mid-command.
- Scene 4 is deterministic (offline stubs, same job-card contract as live
  stations) — if a take is ruined, just re-run it. `--live` is the same
  scene with real Muse stations; only record it logged in, off-camera.
- Never show: API keys, `muse login` approval, real project paths beyond
  this repo, push-notification permission prompts with real device names.
- Suggested title: *"I gave a software factory one sentence before bed"*
- Suggested description first line: the one-line promise, then the three
  commands from the README (`wizard`, `dashboard`, `demo`).
