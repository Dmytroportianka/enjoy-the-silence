# enjoy-the-silence — a software factory that starts itself

[![CI](https://dmytroportianka.github.io/enjoy-the-silence/badges/ci.svg)](https://github.com/Dmytroportianka/enjoy-the-silence/actions/workflows/ci.yml) [![Coverage](https://dmytroportianka.github.io/enjoy-the-silence/badges/coverage.svg)](https://dmytroportianka.github.io/enjoy-the-silence/) [![Tests](https://dmytroportianka.github.io/enjoy-the-silence/badges/tests.svg)](https://github.com/Dmytroportianka/enjoy-the-silence/actions/workflows/ci.yml) [![Complexity](https://dmytroportianka.github.io/enjoy-the-silence/badges/complexity.svg)](https://dmytroportianka.github.io/enjoy-the-silence/) [![Lint](https://dmytroportianka.github.io/enjoy-the-silence/badges/lint.svg)](https://github.com/Dmytroportianka/enjoy-the-silence/actions/workflows/ci.yml)


It stands itself up on a machine that isn't yours: a rented VPS, a spare box, a throwaway container. Your laptop is only a window. **State the work in one sentence, then watch the floor live or walk away. The run is the same either way** — sit and watch the stations like a floor manager, go drink tea, or leave it running overnight; overnight is just one way to not attend.

Point the wizard at a rented VPS, a spare box at home, or a throwaway container. It generates the whole environment (reproducible NixOS base, its own Gitea, a governed agent crew, a control room) and the factory commissions itself there. Your laptop is only a window: state the work in one sentence, then close it.

Inside that box the crew runs at full power, no permission prompts, because the box is built to be disposable: per-task worktrees, rollback to a previous OS generation, every change landing through git. Nothing on the machine is precious, so nothing is protected by slowing the agents down. The gates decide what leaves the box and lands in your real projects.

**Live demo:** [dmytroportianka.github.io/enjoy-the-silence](https://dmytroportianka.github.io/enjoy-the-silence/) — short filmed clips of a feature being created, models being switched, and a quota failover, plus how to run your own.

Clone this template, run the wizard, and the factory commissions itself:
reproducible base poured, its own Gitea installed, a governed Muse crew
online, control room live, order queue open. Then give it one sentence —
*"add this service / expose this app"* — and the crew manufactures
it: work order → isolated stations → QC that can stop the line → delivery
→ run report. The run is identical either way: watched live from the control room, or left alone until the report lands.

Built by a solo maintainer whose side projects exist only because the crew
works unattended. The point is not raw speed. It is a reproducible
workflow with the careful parts baked in, so the owner does not have to
set up each workspace by hand or re-brief every new session:

1. **Context lives in files, not in a chat** — the task record, plan,
   project `decisions.md`, souls, job cards and deliveries are on disk.
   Sessions are disposable; any fresh agent — or the same one after a
   restart — resumes from the files, not from your memory.
2. **Workspaces are manufactured, not hand-crafted** — every task gets an
   isolated worktree, one job card per station, a verify command, and the
   same gates: plan → red-team → build → independent review → retro.
3. **Check AI output with a different context** — QC/redteam is always a
   separate session from the builder. Never the line grading itself.

The owner's job shrinks to stating the work in one sentence and answering
the questions the Inbox cannot settle itself.

## Use it for

- **Unattended feature work on real projects** — state a feature and sit
  watching the stations live, check in now and then, or leave it running
  overnight; the run is identical either way. Planning, red-teaming, building, dual review
  for you in the run report instead of a chat thread.
- **Several projects at once** — register each repo once; every task gets
  its own worktree and runs in parallel under a cap you control, so a
  homelab service, a client app and this factory itself can all be in
  flight without stepping on each other.
- **Work too big for one chat** — refactors, migrations, multi-page UI
  work: work that needs a plan attacked by two independent reviewers, a
  builder that can be bounced and rework, screenshot approval of the
  pages it touched, and a retro that files what it learned as new work.
- **Spending quota where it is cheapest** — judgment stations on a strong
  model on one subscription, execution on a fast model on another; when
  one subscription runs dry mid-task, stations fail over to your backup
  chain instead of the whole factory stopping.
- **Trying a new coding agent without re-platforming** — swap a station
  (or all of them) from muse to agy, gemini, claude or codex in Settings
  and compare on the same workflow, same gates, same records.

## Why a factory instead of just a coding agent

Mainstream coding agents are excellent inside one session — and that
session is exactly the problem they leave you with:

- **Agent- and model-agnostic by construction.** The crew is stations
  with job cards, not a vendor's chat: each station independently picks
  its CLI runner, model and effort. Presets are ordered groups; quota
  exhaustion or a critical failure/error rate (for example 50% of recent
  stations) auto-selects the next preset. Switching agents is a Settings
  change, not a migration.
- **Workflows more complicated than a prompt.** One statement runs a
  persisted pipeline — triage → plan → dual red-team → build → dual
  review → visual screenshot approval → land → retro — with gates that
  can stop the line (plan approval, decisions conflicts, craft vetoes,
  visual diffs). Minor findings don't bounce work; they are deferred and
  offered to the next related task.
- **Your building setup is isolated from your system.** The factory
  commissions a reproducible NixOS base (throwaway Incus, existing
  machine, dedicated box, or cloud) and only ever *generates* OS config —
  applying it stays yours. Agents work in per-task worktrees, never in
  your checkout; rollback is a git revert or a previous NixOS generation.
- **Context that survives sessions.** Plans, decisions, red-team
  arguments, per-station deliveries and token consumption are files on
  disk. Kill any session — or the whole server — and the next agent
  resumes from the record, not from a transcript you must re-brief.
- **Proof instead of vibes.** Every claim of done passes the project's
  own verify command; UI changes additionally pass your eyes via
  Before/After/Diff screenshots stored outside git. The line can visibly
  say no to itself — and does.

Easiest start: paste the prompt in [START_WITH_MUSE.md](START_WITH_MUSE.md)
into a Muse session opened in this repo and let it commission the factory.

## Start it

```bash
bun install
bun run wizard -- --target incus --brain muse --out ./my-env   # generates, never applies
bun run wizard -- --target clean --special "add tailscale, open port 8080" --out ./my-env  # Muse scaffolds special cases
bun run dashboard   # control room: http://localhost:4319
bun run demo        # offline rehearsal (planted fault included)
bun run badges      # regenerate the README/Pages badge images from real measurements
bun run record-feature   # same rehearsal filmed: mocked Muse, dashboard, Playwright video
bun run start       # showcase page: http://localhost:4317
```

The wizard targets `incus` (throwaway), `existing` (module for your NixOS),
`clean` (dedicated hardware — run it on that LAN machine itself so the
agent can tailor to the box), or `cloud` (OpenTofu; token stays in your
shell). Templates cover the common cases deterministically; `--special
"<cases>"` hands the rest to a Muse builder session, checked by a
separate QC session before any agent file is written. Still generate-only.
It installs Muse pinned and hash-verified (1.4.10). One step is
manual on purpose: the plan login. The owner turns the key — unattended
work bills per-token to your own Meta Model API key instead.

## Layers

- **Base** — NixOS, only for reproducibility: same factory on your VM as on
  the reference machine, rollback = previous generation. See `template/`.
- **Self-storing loop** — Gitea on the same machine holds the factory's own
  configs, branches and PRs. `scripts/mirror-out.sh` keeps one external
  copy, so local Gitea is never the sole copy.
- **Crew** — thin orchestrator (`src/crew/`): spawns each station as a
  separate process (headless preset: `muse exec --json`,
  `--session-id` to resume, JSONL parsed), job cards in `/data`,
  reconcile on restart.
- **Governance** — gates ported from the reference `.pi/extensions` as
  Muse hooks (`governance/`): clarification intake, tradeoff,
  redteam line-stop, plan-mode lockout, retrospective shift log. Global;
  per-repo config tunes strictness only.
- **Dashboard** — the control room (`dashboard/`): floor, work orders,
  station detail, governance stop-points, run report. Owns no state.
- **Status** — the in-VM backdoor (`status/`, :8123): factory metrics,
  running Muse subsessions (instead of tmux panes), and one web
  terminal tab for verifying a scaffold from inside the box. The wizard
  copies it into Incus generations and installs it as a systemd unit
  when the status page is on. Terminal writes are bcrypt-gated.

Extracted from a private homelab monorepo — that repo is the reference
deployment, never the artifact. The seed ships only bedrock
(NixOS/tmux/git/Bun) and its own thin crew code.

## Station models

Judgment runs on the strong model, execution on the fast one:

- **`muse-wonder-1.0`** — planner, red-team SME, decisions judge, retro.
- **`muse-spark-1.3`** — builder, coder review, QC, outsider.

The builder climbs a tier ladder across attempts: `muse-spark-1.3`
at low effort, then medium, and only escalated retries earn
`muse-wonder-1.0` at high.

**Providers & presets:** a station's runner is a subscription, not a
constant. Settings → Model presets holds complete routing sets —
provider (`muse`, `agy`, `gemini`, `claude`, `codex`; selectable only
when installed), model and effort per station — in swap order, as many
as you like. The factory suggests presets from your installed agents,
including cross-family ones (Gemini writes the code, Muse checks it).
When a provider reports a quota/usage limit it is marked exhausted
until its reset backoff and the whole factory swaps to the next preset
(fresh session — resume ids never cross providers). Each preset can also
switch at a critical failure or provider-error rate over recent stations;
only when every preset is exhausted or skipped does the task park as before.

## Verify

```bash
bun run verify        # typecheck + tests/coverage + Biome + ESLint + suppression audit
bun run fix           # auto-fix formatting and lint after writing code
bun run coverage      # tests with text + lcov coverage
bun scripts/craft-scan.ts --diff --base HEAD   # comment + content findings on a diff (advisory)
scripts/publish-public.sh /tmp/enjoy-the-silence-public   # manifest + leak grep + smoke
```

`verify` is the only definition of done. GitHub CI runs it plus a separate mocked demo-health job (feature creation, provider presets, quota failover; no model tokens spent) on every push to `main`. The conventions it enforces —
formatting chosen for additive diffs, cognitive-complexity and function-length
ceilings, naming, closed-set types, and explained suppressions (disabled lints
and skipped tests must say why) — are documented in
[PATTERNS.md](PATTERNS.md) and checked by the coder reviewer on every diff.
Coverage is measured on every run; the threshold arms after the dashboard UI
has tests.

Verification is fluid per stack: a JS repo states its gate via a `verify`
script; cargo/go/python repos are verified with their canonical test
commands. Other repos can take the gate:

```bash
scripts/project-gates.sh /path/to/repo    # biome.json + bunfig.toml + PATTERNS.md
```
