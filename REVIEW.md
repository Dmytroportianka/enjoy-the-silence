# Whole-repo code review

Scope: all tracked code (~13.8k lines before this pass: `src/`, `dashboard/`,
`demo/`, `scripts/`, `governance/`, `status/`, `server.ts`, `plugins/`).
Method: run the new static-analysis pipeline, fix mechanical findings,
review the semantic findings by hand, record the rest here.

## Commit review: `2ef1d29` + `37499a8` (gates, PATTERNS.md, suppression scanner)

Verdict on the original two commits: **REJECT** — one blocker, found by the
review and fixed in the follow-up commit. Findings below; 1–3 are fixed,
4–6 are recorded decisions.

1. **Blocker — the committed gate was red on main.** `bun run verify`'s
   suppression audit failed on the tree as committed in `37499a8`
   (9 falsely "unexplained" suppressions). Two causes, both fixed:
   - The scanner counted suppression markers inside **string literals** —
     its own test fixtures and pattern table matched themselves (23 false
     hits). Fix: string contents are blanked before matching; a real
     suppression is a comment or code, never string data.
   - The audit scanned **tracked files only**; the scanner's files were
     untracked when `verify` ran green, tracked after `git add -A` — so the
     gate was verified before the commit and failed after it. Fix:
     `git ls-files --cached --others --exclude-standard`. Process rule that
     falls out of this: `verify` runs after staging, and now it cannot be
     fooled either way.
2. **High — scanner coverage gaps.** Fixed: `biome-ignore assist/...`
   categories (only `lint/` was matched); block-comment disables
   (`/* eslint-disable */`, `/* biome-ignore ... */` — the whole-file form,
   the most dangerous one); `pytest.mark.skipif`; `t.Skip("message")` now
   counts its message as the reason; git's `\ No newline at end of file`
   no longer shifts line numbers.
3. **Medium — false attribution in the task audit log.** When the new
   per-stack default gate passed, the system prompt claimed "the builder
   named a working one" — no builder had run. Prompts feed later stations,
   so the log must say what actually happened; it now says the project
   states its own gate.
4. **Fixed (was: owner decision) — verify timeout vs canonical gates.**
   `runVerify` defaulted to 120 s while the final gate passed 600 s — two
   timeouts for the same check. A cold `cargo test` or a full suite under
   `bun run verify` can exceed 120 s and read as a verify failure, bouncing
   the task into the builder loop on a check that would have passed.
   Fixed by one constant (`VERIFY_TIMEOUT_MS = 600_000`) as the single
   default for every verify run: this factory works the night shift, a slow
   check stalls one loop iteration, and the station timeout (60 min) still
   bounds the line. The same fix unified gate choice: the builder loop now
   picks its default through `effectiveVerifyCommand` — the same chooser the
   final gate uses — so the loop and the final gate can no longer run
   different commands for one task (the project's stated gate outranks the
   CI-derived suggestion; once the worktree is released, CI-derived is what
   is left). Precedence is tested.
5. **Noted — the format churn is one-time.** `2ef1d29` reformatted 49 files
   (+17k/−3.3k lines). Expected; review content in that commit, not layout.
   Verified clean: no keyword-splitting damage from Biome's `--suppress`
   bug (grep clean), no dangling references after the dead-code removals
   (typecheck), and the App.tsx push-block removal is behavior-preserving
   (service-worker registration kept; dead duplicate state removed).
6. **Fixed (was: noted) — denominator drift in the docs.** Hand-counted
   suppression numbers in different docs used different lenses (ratchet
   entries vs all markers) and drifted. Fixed by making the audit the
   single source: docs cite `bun scripts/suppressions.ts --audit` output
   (currently 96 markers, 0 unexplained) and no longer itemize compositions
   by hand.

What survived review unchanged: the publish-manifest repair and the
`.leak-terms` pipefail fix (publish smoke green end to end); no skipped or
focused tests anywhere in the tree; all suppressions carry reasons; the
ratchet placements are on the right nodes; and the scanner's diff line
numbers verify against hunk headers, deleted lines and no-newline markers.


Baseline command: `bun run verify` (typecheck + tests/coverage + Biome + ESLint).

## Baseline after this pass

| Metric | Value |
| --- | --- |
| Tests | 205 pass, 0 fail |
| Coverage (all files) | 88.65% functions, 96.13% lines |
| Complexity/length/naming violations | 0 new — pre-existing hotspots ride the ratchet |
| Suppression audit (single source) | 96 markers, 0 unexplained |
| Biome errors | 0 (6 warnings / 1 info, see below) |

Suppression counts in these docs come from one place —
`bun scripts/suppressions.ts --audit` — and are never hand-itemized, so the
lenses cannot drift apart again.

The warnings left are non-blocking by design (`noExplicitAny` at the
dashboard JSON boundary, one unused wiring leftover already removed).

## Mechanical changes applied in this pass

- `biome.json`: explicit formatter (`lineWidth 100`, spaces/2, `expand: "always"`,
  `trailingCommas: "all"`, double quotes, semicolons); `noExcessiveCognitiveComplexity`
  (max 15); `noExcessiveLinesPerFunction` (max 120, blank lines skipped);
  scoped `useNamingConvention` (object-literal properties and external payload
  keys deliberately exempt).
- `bunfig.toml`: coverage on every run, text + lcov reporters. Threshold is
  commented out on purpose — baseline first, gate later.
- `package.json`: `fix`, `check`, `coverage`, `verify` scripts.
- Repo-wide format pass (49 files). This is the one big diff: the new formatter
  expands every array/object to one entry per line, so the diff is large but the
  next diffs are additive. Review content, not layout, in that commit.
- Renames required by the naming rule (2 files), `@ts-expect-error` directives
  moved to the line that actually errors after formatting, and one purposeless
  block removed from `dashboard/server.ts`.
- 96 suppression comments added as the baseline ratchet, every one with a
  reason. Count and composition come from the single source:
  `bun scripts/suppressions.ts --audit` (96 markers, 0 unexplained at the
  time). They are a ratchet: see `PATTERNS.md`.

## High-priority findings

### 1. `src/crew/dispatch.ts` is the riskiest module (5907 lines, 23 suppressions)

Worst offenders (cognitive complexity): `runTaskPipelineInner` 253,
`landTaskWork` 101, 94, `builderLoop` 88, 64, 61. Function coverage is the
lowest in the repo at **52.79%**.

Why it matters: the pipeline is the product. A regression here is a silently
stuck or falsely-done task, not a cosmetic bug.

Recommendation: split along the phases that already exist (Template Method in
`runTaskPipeline`): plan, build loop, review, land/merge, retro. Each phase
becomes a module with its own tests; the pipeline keeps the skeleton. This
directly removes most of the 23 suppressions instead of growing them.

### 2. The whole dashboard UI is untested (4903-line `App.tsx`)

Coverage reports only backend files — `dashboard/src/App.tsx` is never loaded by
a test. It also carries 25 complexity/length suppressions.

Recommendation: split by view (floor, work orders, station detail, governance,
morning report) and add render smoke tests per view (happy path + empty state).
Even a handful of tests would have caught the duplicated push block that was
removed here.

### 3. `dashboard/server.ts` HTTP handler (255 cognitive complexity)

A single `fetch` branch tree does routing, auth, SSE, static files and every
API endpoint. It is also where auth failures are easiest to get wrong.

Recommendation: a small route table (method + path → handler) — the Strategy
pattern already used elsewhere — with handlers in separate modules. Keep the
auth check as a wrapper around the table so no route can forget it.

### 4. `FactoryStore.deleteTask` (173 cognitive complexity)

Deletion walks receipts, live leases and several persistence files in one
function. A partial failure leaves inconsistent state and is hard to test.

Recommendation: extract the steps (validate → mark deleting → remove task →
write receipt) and make each step fail-safe and tested.

### 5. Closed sets are still stringly-typed at call sites

`TASK_STATES`, `PLAN_STATES`, roles and lanes are `as const` arrays + derived
unions. The type is safe, but call sites still re-type literals (`"done"`,
`"running"`, `"coder"`), so a rename is a grep away from a missed case rather
than a compiler error.

Recommendation (per `PATTERNS.md`): move closed sets that are compared at call
sites to exported `enum`s (or const objects with member access), and pass
members. Do it file by file when touching those files; do not do a big-bang
rename.

## Medium-priority findings

- **`Record<string, any>` at the dashboard API boundary** (`api()` in
  `App.tsx`). Two documented suppressions. Better: define `ApiResponse` per
  endpoint and parse with zod; `any` hides response-shape drift from clients.
- **`eslint.config.ts` custom rule** (32/29 complexity) is the one slow,
  stateful analyzer. It works, and it is isolated to tests; leave it unless the
  rule needs changes.
- **`src/crew/preset.ts` JSONL parser** (`feed` 42, `parseMuseOutput` 23) mixes
  buffer management, parsing and display formatting. Splitting the incremental
  parser from the line describer would make it testable without a session.
- **`src/crew/store.ts`** (84% function coverage) — file/JSONL/SQLite facade.
  The missing paths are error branches; add targeted tests rather than
  refactoring.
- **Verify defaults only cover one project shape.** `defaultVerifyCommand`
  picks `bun run verify` for repos that ship `biome.json` + a `verify` script.
  Other stacks still fall back to "no command". Extend the detection table
  (package manager + known scripts, `pytest`, `cargo test`) instead of guessing
  from prose.
- **Coverage gate not armed.** Baseline is recorded above; enabling
  `coverageThreshold = { lines = 0.8, functions = 0.8 }` in `bunfig.toml` is a
  one-line change once the UI tests land (function coverage is 88.65% now but
  UI code is unloaded, so the number is misleading until then).

## Tooling findings (fixed in this pass)

- `PUBLISH_MANIFEST` had drifted from the tree: 19 tracked files (`ci.ts`,
  `dialogue-db.ts`, `stream.test.ts`, `health.ts`, `leak-check.sh`, dashboard
  assets, `VIDEO_SCRIPT.md`, ...) were missing entries, so the publish gate
  failed on the two-sided check. Added; `scripts/publish-public.sh` now passes
  end to end (manifest + leak grep + install/test/typecheck smoke).
- `scripts/publish-public.sh` aborted with exit 2 whenever `.leak-terms` was
  absent: the `grep` in a `pipefail` pipeline failed before the "nothing to
  check" guard could run. Guarded; a checkout without leak terms now skips
  cleanly instead of failing the publish.
- `coverage/` is now gitignored (lcov output is a build artifact).

## Test-suite note

The intermittent failure first seen during the gate pass is now identified and
fixed — it was two distinct flakes in `dashboard/dashboard.test.ts`, not load
sensitivity:

1. The manual-plan test raced the auto-approve tick: planning finished, the
   tick approved and dispatched the plan, and the test's plan save then 400'd
   ("cannot draft a plan while running"). The test drives the manual flow, so
   it now pins click-mode (restored in `finally`). The same race exists for a
   real owner editing a plan in the dashboard while auto-approve fires —
   listed below as an open product finding.
2. The dev-server test picked a port inside the file's own server range
   (4800–4999 ⊂ 4600–5099); on collision the dev port served the control room
   HTML and the assertion failed. The dev range is now disjoint (5200–5399).

Eight consecutive full-file runs pass after both fixes. Product finding left
open: `POST /api/tasks/:id/plan` returns a bare 400 when the plan was
auto-approved mid-edit — the approve endpoint is already idempotent; the plan
endpoint should similarly return the current task (or a 409 with state) so the
UI can explain instead of erroring.

## What is already good

- Boundaries are real: zod parsing at file/JSON/HTTP/CLI edges, no `as` casts on
  loaded data, `unknown` rather than `any` in the crew.
- Separation of judgment and execution (strong model plans, fast model builds)
  is encoded in policy (`builderRoute`), not scattered through the code.
- The offline demo and stub agent make the pipeline testable without a model.
- Governance gates are small, pure functions with direct tests
  (`src/governance/gates.test.ts` is at 100%).
- SSE streaming keeps the dashboard stateless and reconnect-safe.

## Suggested order of work

1. Split `dispatch.ts` by pipeline phase; delete suppressions as functions shrink.
2. Split `App.tsx` by view; add render smoke tests; then arm the coverage gate.
3. Replace the `fetch` branch tree with a route table.
4. Split `deleteTask` and add failure-path tests.
5. Migrate closed sets to enum members file by file when touched.

This file is a snapshot, not a gate. Update it when a finding is closed.
