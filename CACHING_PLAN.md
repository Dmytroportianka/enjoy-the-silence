# Inter-station caching plan

Goal: cut token spend between stations without breaking the governance rule that
QC/red-team run in a *different context* from the builder. Caching must never
leak one station's reasoning into another's; it caches *artifacts*, not sessions.

## Effectiveness guardrails (read this first)

The user's concern: caching context could make red-team and the independent reviewer
*less* effective by priming them with the builder's framing. These rules keep the
cache from becoming a homogenizer. They override anything below that conflicts.

1. **The context pack is a deterministic concatenation of raw files — never an
   LLM summary.** If an LLM "summarizes the context" for reuse, every station
   inherits that model's interpretation and blind spots, and red-team stops
   finding what the summarizer smoothed over. Assembly is string concatenation
   + truncation rules only. No model call in the cache path.
2. **Cache inputs, not verdicts, for red-team/QC/reviewer.** Items 5 in the
   sequencing list (red-team verdict cache) is the one place this can bite: a
   cached "PASS" on an identical plan skips the fresh attack that might catch a
   new failure mode. Keep red-team/QC verdicts uncached by default; allow
   caching only behind an explicit flag and only as "re-verified, unchanged",
   never as a skip. The cheap stations (file reads, verify results) are where
   the savings are.
3. **Per-role slices, not one shared pack.** Red-team should see plan + diff +
   decisions; builder sees plan + rules; QC sees diff + acceptance criteria.
   A single "context.md" fed to everyone re-creates the priming problem. Build
   `context.<role>.md` (or filter the pack by role) so each station gets the
   facts it needs and no more. The cache key still includes the full input set.
4. **Keep system prompts and souls independent.** Prompt-prefix caching is
   per-session/per-role; red-team's cached prefix is red-team's, never the
   builder's. No cross-role prefix sharing.
5. **Preserve adversarial framing.** The cache must not rewrite or "clean up"
   a station's prompt. Cached content is injected verbatim; the job card's
   attack instructions stay untouched and are never derived from cached output.
6. **Diversity valve.** On escalated retries and on a sampled fraction of tasks
   (e.g. 1 in 8), run red-team/QC cold (no cached context pack, full file
   reads) to preserve independent discovery and to measure whether caching
   degrades catch rates. Report the delta in the morning report.

Net effect: caching saves the *mechanical* re-reading (file I/O, re-tokenizing
identical prefixes) but leaves the *cognitive* independence of each station
intact. The risk you identified is real only if we let an LLM summarize or if
we cache verdicts — both are explicitly forbidden above.

## What is safe to cache (and what is not)

Safe (artifacts, deterministic):
- Assembled task context pack (task record + plan + relevant decisions + rules).
- File snapshots and their hashes (decisions.md, PATTERNS.md, souls, job card).
- Verification results for an unchanged worktree (already partially done —
  dispatch.ts notes "a passing suite costs no tokens").
- Red-team verdict keyed by plan hash + repo state hash (short-circuit only
  when nothing changed; never cache a REJECT as PASS).

Not safe (must stay separate sessions):
- Builder's chain-of-thought must not reach QC or red-team.
- Reviser resuming the planner's session is OK (same role, plan refinement).
- QC/resumer escalation can reuse a session only within the same role.

## Status

Implemented (`src/crew/context-pack.ts`): per-role packs, content-hash keys,
verify-result caching. The pack key/content exclude volatile task fields
(state, attempts, timestamps) so retries and re-dispatch hit both the disk
cache and the API prefix cache; semantic changes (plan, lane, tags,
decisions, patterns) still invalidate. Red-team/QC verdicts stay uncached
per the guardrails above.

## Proposed design

### 1. Context pack per task (`src/crew/context-pack.ts`, new)

Assemble once into `factory-data/tasks/<id>/context.md`:
- task record (title, prompt, lane, tags — never state or attempt count:
  volatile fields in the key/content made every retry a cache miss, fixed
  in v3 of the pack scheme)
- approved plan
- relevant `decisions.md` bullets (grep by task keywords, or whole file if small)
- `PATTERNS.md` excerpt (the rules section, not examples)
- station souls for the roles that will run

Cache key: `sha256(task record + plan + decisions mtime + patterns mtime + souls)`.
Store key + mtime in `context.md.meta.json`. Regenerate only when the key
changes. Every station reads `context.md` instead of re-reading 5-8 files, which
is where most per-station token spend is today.

Invalidation: any write to plan, decisions, patterns, or souls bumps the key.
The orchestrator recomputes the key before spawning a station and regenerates
if stale.

### 2. Prompt ordering for API prompt caching

Meta's session logs already record `cached_input_tokens`/`cached_tokens`, so the
Meta Model API supports cached input. Order each station's prompt so the stable
prefix comes first:
1. System/rules (PATTERNS, governance) — stable across tasks.
2. Context pack — stable within a task.
3. Task-specific instruction + diff — variable, last.

This lets the API reuse the cached prefix instead of re-tokenizing it. Today
the order is not specified anywhere; standardize it in the job-card template
(`src/crew/jobcard.ts`) and the prompt builders in `dispatch.ts`.

### 3. Session reuse where governance allows

- Planner → Reviser: resume the planner session (`--session-id`) so the
  reviser refines instead of re-reading the plan. Saves one full context load.
- Builder retries: resume the builder session on retry (already implied by
  `--session-id` resume support in preset.ts) instead of starting cold.
- Red-team / QC / coder review / retro: always new sessions (governance).

### 4. Verification result cache (extend existing)

`dispatch.ts` already short-circuits passing suites. Make it a real cache:
- Key: worktree HEAD commit + verify command + env hash.
- Value: { passed, output tail, timestamp }.
- Re-run only on new commit or TTL (e.g. 10 min). A re-run of QC after a
  fixer patch still runs (worktree changed), but a re-read of the same tree
  does not. Already mostly there; formalize and persist to `factory-data/cache/verify/`.

### 5. Red-team / QC verdict cache (off by default)

- Default: OFF. Red-team and QC always run fresh. This is the one cache that
  can silently erode the independent-context guarantee, so it is opt-in only.
- When enabled (owner flag in governance settings): key = plan hash + repo
  state hash + station soul version. Value = verdict + findings + a
  "re-verified, inputs unchanged" note. Surfaced as re-verification, never
  as a skip, and never cached after a downstream REJECT on the same key.
- Purpose is cost visibility on repeat identical plans, not skipping review.
  The diversity valve (guardrail 6) keeps a cold run in the mix.

### 6. Cache module shape

New `src/crew/cache.ts`:
```ts
export interface CacheEntry<T> { key: string; value: T; createdAt: number; ttlMs: number; }
export function cacheGet<T>(namespace: string, key: string): T | null;
export function cacheSet<T>(namespace: string, key: string, value: T, ttlMs: number): void;
export function cacheInvalidate(namespace: string, key?: string): void;
```
Storage: `factory-data/cache/<namespace>/<sha256(key)>.json`, atomic write +
rename, same pattern as `settings.json` in dashboard/server.ts. TTL enforced on
read. A `bun run cache:clear` script (or `--clear-cache` flag on the crew CLI)
wipes the dir.

### 7. Observability

Reuse the in-progress per-model cost work to report cache hit rate per task:
"tokens saved by cache: X". Without measurement we cannot tell whether the
cache helps; add `cacheHits`/`cacheMisses` to the delivery note and surface in
the morning report.

## Sequencing (smallest first)

1. ✅ Context pack + its hash key (biggest token win, lowest risk). Implemented: `src/crew/context-pack.ts`, wired into builder + reviewer.
2. ✅ Prompt ordering standardization — satisfied by step 1's role-sliced packs (fixed section order) + stable-first assembly in builder/reviewer task strings. Meta API cached-input rate applies on retries.
3. ✅ Verify cache persistence — `runVerify` now keys on `sha256(worktree HEAD | verifyCommand)`, 10-min TTL, persisted to `factory-data/cache/verify/`. Both call sites pass the cache dir.
4. ✅ Session resume — already in place: `runStation` resumes via `store.getSession` + `--session-id`; reviser/red-team re-review use `deltaTask`; builder retries use `deltaTask`. No new code needed.
5. ⬜ Red-team verdict cache behind a flag. ~1 day, owner-gated. (Off by default per guardrails.)
6. ✅ Cache hit/miss reporting in delivery notes. `DeliveryNoteSchema` now carries optional `contextPackHit` and `verifyCacheHit`; builder and reviewer augment their delivery notes with these. (Morning report surfacing is dashboard-side and not yet wired.)

## What not to do

- Do not cache QC's verdict as PASS and skip QC. QC must always run on a
  changed worktree; the cache only avoids re-running on an unchanged tree.
- Do not share a session between builder and QC — violates the independent-
  context rule in decisions.md.
- Do not cache across tasks with different base commits; key must include
  repo state.
- Do not make caching mandatory/unbypassable; keep a `--no-cache` flag for
  debugging and for the red-team station itself.