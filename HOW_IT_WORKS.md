# How the factory works

A software factory that commissions itself: reproducible OS base, self-hosted
Gitea, a governed agent crew, and a control-room dashboard. Give it one
sentence (*"add this service / expose this app"*) and the crew
manufactures it, unattended: work order → isolated stations → QC that can stop
the line → delivery → run report.

## Why NixOS for the base

NixOS is selected for **reproducibility and rollback**, not for speed:

- Same factory on your VM as on the reference machine: the whole base is a
  declarative config (`template/`), so `nixos-rebuild switch` produces an
  identical system every time.
- Rollback is a previous generation: `nixos-rebuild switch --rollback` (or
  picking an older generation at boot) restores the whole machine state.
- The wizard (`scripts/wizard.ts`, `src/wizard.ts`) only *generates* config —
  it never applies it. The owner reviews the generated files and runs the
  rebuild. This keeps the agent from silently changing the OS.
- Targets: `incus` (throwaway container), `existing` (module for your NixOS),
  `clean` (dedicated hardware — run on that box so the agent tailors to it),
  `cloud` (OpenTofu; token stays in your shell).

The wizard installs Muse pinned and hash-verified (1.4.10). One step is manual
on purpose: the plan login. Unattended work bills per-token to your own Meta
Model API key, so the owner turns the key.

## Why different agents, models, and effort levels

The crew is model-agnostic in shape. Stations are routed to a provider,
model and effort by `tierFor` and `liveRoutes` in `src/crew/dispatch.ts` and
`src/crew/orchestrator.ts`; the defaults below are the muse routes.

| Station | Model | Effort | Why |
|---|---|---|---|
| planner | muse-wonder-1.0 | high | Needs deep reasoning to draft intent, approach, success criteria, prerequisites. |
| redteam (SME + outsider) | muse-wonder-1.0 | medium | Attack the plan; needs judgment but not full build depth. Two independent agents. |
| sme / coder (review) | muse-wonder-1.0 | medium | Review the diff against patterns; needs care. |
| builder | muse-spark-1.3 | low → medium → high (escalates) | Fast coding model early; escalated retries earn the strong model. |
| coder | muse-spark-1.3 | high | Implementation/rework. |
| outsider | muse-spark-1.3 | low | Cheap independent glance. |
| fixer | muse-spark-1.3 | medium | Resolve rebase conflicts, mechanical. |
| retro | muse-wonder-1.0 | (default) | Review the whole run and file learnings. |

Effort escalates with attempts: early attempts use the fast coding model; only
escalated retries earn the strong model (`tier.name`: fast/standard/smart).
This keeps cost down while preserving quality where it matters.

## Providers: every runner is a subscription

Each CLI runner (`muse`, `agy`, `gemini`, `claude`, `codex` — adapters in
`src/crew/providers.ts`) is a different subscription with its own quota, so
Settings → Model routing picks provider + model + effort **per station**
(selectable only when the binary is installed on the machine), organised as **presets**: complete routing
sets in swap order, as many as the owner keeps. Settings suggests presets
from the agents actually installed — including cross-family ones, where one
model family writes the code and a different subscription checks it (the
factory's independent-checking rule applied to providers). When a station's
provider reports a quota/usage limit, that provider is marked exhausted
until its reset backoff (`provider-quota.json`) and the whole factory swaps
to the next preset; the station retries there with a **fresh session**
— resume ids are stored per provider and never cross runners. A provider
already in its backoff is skipped without spending a call. Only when every preset
is exhausted does the old behaviour return: the task parks as `quota:` and
the global pause applies. Caller model overrides from tier escalation name
muse models and apply to muse routes only; other providers keep the model the
owner picked for them. Every delivery records which provider produced it.

Independent context is a governance rule: QC/red-team always runs in a **separate
session** from the builder. The builder's chain-of-thought never reaches the
reviewer. Sessions are disposable; context lives in files (task record, plan,
decisions, souls, job cards, deliveries), so any fresh agent resumes from disk.

## The station pipeline (per task)

1. **Triage** — estimates size/risk, picks the lane: fast (no red-teams, auto-approve plan), standard (plan + both red-teams + dual review), careful (extra scrutiny). Lane can be overridden by the owner.
2. **Plan** — planner drafts `PLAN-DRAFT.md` (intent, why, approach, success criteria, prerequisites). A boundary gate sanitizes the card.
3. **Red-team (SME + outsider)** — two independent agents attack the plan; both must pass. Written arguments are recorded. Every point is tagged `MAJOR` (blocks the plan) or `MINOR` (worth fixing later): a rejection with only MINOR points accepts the plan as drafted — no reviser/re-review rounds — and writes the points to the project's deferred list (Inbox, dismissible). When a later task looks related, each deferred point returns as a blocking plan question: the owner answers include (the point folds into that plan, marked `[deferred:<id>]`, and closes) or skip (it stays deferred).
4. **Build** — builder implements in an isolated worktree (warm-pool slot). Intermediate-state evaluation on timeout: progress → resume, no change → reiterate with smaller step.
5. **Review (coder + QC)** — diff checked against `PATTERNS.md` and success criteria. A `REJECT` bounces the builder with a reason (e.g. "weak coverage — smoke check accepts any string").
6. **Craft gate** (UI/copy changes only) — closed-set veto: `DEAD-CONTROL`, `FAKE-CLAIM`, `GHOST-LINK`, `SCRIPT-PATCH`. Anything else is a retro point, not a bounce.
7. **Visual Review** (page/UI changes only) — Argos-style screenshot diffs. The planner declares key moments in a `## Visual moments` plan section (`- name: /route`, optional viewport and `click:`/`fill:`/`press:`/`wait:` steps); the builder mirrors them as the e2e spec `visual.moments.json`. The factory screenshots each moment on the base commit (baseline, exported via `git archive` outside any repo) and on the feature worktree (after), pixel-diffs them (changed pixels painted red), and parks the task before Land when anything is new or changed. The owner inspects Before/After/Diff per screenshot in the dashboard: **Approve & land** pins the exact approved screenshot hashes and lands; **Request changes** sends per-screenshot comments back to the builder and the stage re-captures after the rework. No visual change, or a task with no page affected, passes automatically. All screenshots live only under the factory data dir (`tasks/<id>/visual/`) — outside git history, never committed.
8. **Land** — verified branch merges to main (isolated path if main checkout is dirty).
9. **Retro** — a retro agent reviews the whole run and files findings as candidate tasks.

Gates are armed per card; a veto short-circuits before any agent spawns.

## Retro points

After a task finishes (done or failed), a sweep (`sweepRetros` in
`dashboard/server.ts`, running every 3s tick) waits 30s for records to settle,
then runs `runRetro` with a fresh muse session. The retro agent reviews the
whole run (plan, diff, deliveries, prompts) and returns findings.

Each finding is filed as its own candidate task via `fileRetroPoints`:
- tagged `retro-point`,
- state `planned`, `planState: none`, `planRequested: false`,
- appears in the Inbox as a "candidate" request for the owner to **accept**
  (planning starts) or **remove**.

This turns "we noticed X during the run" into a tracked, reviewable task rather
than a forgotten note. Example: a retro might file
*"smoke check accepts any string — pin the greeting"* as a candidate task.

## Caching and cost control

- Context packs (`src/crew/context-pack.ts`) assemble role-specific stable
  context once, cached by content hash: task + plan + decisions + patterns +
  souls + file list, sliced per role. Builder sees plan brief + settled
  decisions + patterns + souls + file list; red-team sees full plan + decisions.
  The cache key and the pack bytes deliberately exclude volatile fields
  (task state, attempt count, timestamps): keying on them made every retry a
  cache miss and a fresh API prefix. Semantic changes (plan, lane, tags,
  decisions, patterns) still invalidate, and the pack version bumps when the
  scheme changes.
- Verification results cached by `sha256(worktree HEAD | verifyCommand)`, 10-min TTL,
  persisted to `factory-data/cache/verify/`.
- Session resume: builder retries resume via the provider's resume flag;
  planner→reviser resume; red-team/QC/coder-review/retro always fresh sessions
  (governance). Stored sessions are provider-scoped.
- Scripted checks cost no tokens at all: the Visual Review stage is pure
  Playwright + pixel diffing, and the suppression/comment/content scans are
  static. Minor-only red-team rejections skip the reviser and re-review rounds
  entirely (see Red-team above), which removes the most common planning bounce.
- Prompt ordering: stable prefix first (system/rules, then context pack, then
  task-specific instruction + diff) so the Meta API can reuse cached prefixes.

## Example: one sentence → landed feature

Input: *"add a hello service and expose it at /hello"*

1. Triage picks **standard** lane (two red-teams).
2. Planner drafts the plan with intent, approach, success criteria.
3. Red-team SME + outsider both pass (written arguments recorded).
4. Builder ships a smoke check that accepts any string → **coder reviewer
   REJECTs** ("weak coverage — smoke check accepts any string").
5. Builder reworks, pins the greeting; both reviewers pass.
6. Verify gate passes; branch lands on main (`hello.js`, `hello.test.js`).
7. Retro files a finding: *"smoke check too weak to pin the payload"* as a
   candidate task in the Inbox.

Consumption is recorded per station (input/output tokens, and which provider
ran it) and surfaced on the task card. The whole run is visible in the control
room with live agent output.

## Demo recordings

Three short clips under `demo/recordings/` show the flow end to end, each
filmed by Playwright against the real dashboard with every model call mocked
(`demo/pipeline-stub.ts`, `demo/provider-stub.ts` — zero tokens, deterministic,
behaviour mirrored from real runs in `factory-data`):

- `create-feature.webm` — one sentence stated in the UI → landed feature.
- `switch-models.webm` — model presets in Settings: adding a suggested
  cross-family preset (Gemini builds, Muse checks) and making it active.
- `quota-failover.webm` — the active preset's agy quota is exhausted
  mid-feature; the factory swaps to the muse preset and finishes it.

Re-record with `bun run record-providers` (`--scene create|models|failover`
for one clip, `--no-video` for the CI twin test).

## Why this matters

- Context lives in files, not chat: sessions are disposable; any fresh agent
  resumes from disk.
- Workspaces are manufactured: isolated worktree, one job card per station,
  verify command, same gates every time.
- Check AI output with a different context: QC/red-team is always a separate
  session from the builder. The line never grades itself. A factory that visibly
  says no to itself is the point.