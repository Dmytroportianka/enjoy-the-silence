# Factory usage — log review

Snapshot taken 2026-11-02 19:01 UTC. Sources: `factory-data/jobs/*/*.delivery.json`
(factory station deliveries, which carry per-station `inputTokens`/`outputTokens`),
`factory-data/quota-pause.json`, `factory-data/tasks/*/task.json`, and the
underlying muse session logs under `~/.local/share/muse/sessions/...`.

## Headline

| Metric | Value |
|---|---:|
| Station deliveries recorded | 121 |
| Deliveries with token counts | 117 |
| Deliveries without counts (quota failures) | 4 |
| **Factory input tokens** | **886,485,643** |
| Factory output tokens | 1,400,355 |
| Factory cached (prompt-cache) tokens | 82,573,060 |
| Total context processed | ~969,058,703 |
| Stations: done / failed | 114 / 7 |
| Models: wonder-1.0 / spark-1.3 (station count) | 77 / 44 |

Input tokens dominate (~630× output). The builder station is the cost centre:
the five largest single runs are all `builder` and account for ~820M input tokens
(93% of the factory total).

## Quota status

`factory-data/quota-pause.json`:
- `until`: 2026-11-02 19:30:23 UTC
- `nextProbeAt`: 2026-11-02 19:05:23 UTC (already passed; factory is probing)

All 7 failed stations are quota/429 failures, not code failures:

| Task | Station | Reset window |
|---|---|---|
| task-17936263801791 | builder, plan-revalidator | 2026-11-02 23:11:18 UTC |
| task-1793631133334 | builder | 2026-11-02 23:11:18 UTC |
| task-17936357652870 | sme | 2026-11-02 23:11:18 UTC |
| task-17936371065410 | builder | 2026-11-02 23:11:18 UTC |
| task-17936371065770 | retro | 2026-11-02 18:07:52 UTC (passed) |
| task-1793643888037 | plan-reviser | 2026-11-02 23:11:18 UTC |

Two distinct reset windows exist (18:07 UTC, already passed, and 23:11 UTC).
The factory is currently running 2 stations (2 muse processes) with 0 queued
and dispatch enabled; capacity is not the bottleneck, quota is.

## Per-task consumption (input tokens)

| Task | State | Stations | Input | Output | Cached | Title |
|---|---|---:|---:|---:|---:|---|
| task-1793635225068 | in-review | 8 | 293,023,966 | 200,275 | for questions try to fill suggested option so if user agree they can just click |
| task-17936327705150 | done | 9 | 268,363,452 | 279,975 | Make the planner reject plan text that contradicts… |
| task-1793630975677 | done | 10 | 121,967,345 | 175,542 | Add rollback button to done task/feature |
| task-17936371065871 | done | 6 | 83,175,701 | 121,639 | Make verify work in a fresh worktree instead of the slot |
| task-17936357652891 | done | 9 | 65,247,022 | 126,520 | De-flake the dashboard projects API tests that hang |
| task-17936371065770 | done | 9 | 14,219,973 | 100,454 | Gate builder dispatch on plan-stated prerequisites |
| task-1793588868180 | done | 10 | 15,926,241 | 94,223 | Implement rollback of the feature |
| task-1793631133334 | failed | 10 | 4,778,201 | 62,859 | on done task show amount of token used on each task |
| task-17936263801760 | done | 9 | 4,421,754 | 56,096 | Land task branches through a clean isolated worktree |
| task-17936263801791 | needs-input | 9 | 3,145,835 | 47,515 | Record expensive-path tradeoffs during planning |
| task-17936357652870 | blocked | 9 | 3,027,069 | 39,068 | Stop illustrative forbidden-action lines in prompts |
| task-17936371065410 | needs-input | 6 | 2,454,390 | 28,985 | Cover the isolated-landing trigger matrix with tests |
| task-17936357652912 | done | 6 | 2,413,093 | 23,168 | Add entry-point tests proving consistency of surfaces |
| task-1793643888037 | planned | 6 | 2,329,912 | 24,017 | on every finished task we should leave our work in a reviewable state |
| task-17936371065831 | running | 4 | 1,591,528 | 15,794 | Extract isolated worktree landing into a separate module |
| scout-enjoy-the-silence-1793588852466 | (scout) | 1 | 400,161 | 4,225 | project scout |

Heaviest single runs (all `builder`):

| Input tokens | Task | Model |
|---:|---|---|
| 290,413,725 | task-1793635225068 | wonder-1.0 |
| 265,129,138 | task-17936327705150 | spark-1.3 |
| 119,096,272 | task-1793630975677 | spark-1.3 |
| 82,109,230 | task-17936371065871 | wonder-1.0 |
| 63,358,870 | task-17936357652891 | wonder-1.0 |

## Muse-wide (all sessions, not just factory)

| Metric | Value |
|---|---:|
| Session files | 6,660 |
| Sessions with usage records | 6,627 |
| Input tokens | 3,672,969,684 |
| Output tokens | 5,418,443 |
| Cached tokens | 1,913,362,157 |
| Models seen | muse-wonder-1.0, muse-spark-1.3 (plus sessions with no model field) |

The factory subset (886M input) is ~24% of all muse input. The remainder is
interactive muse sessions and other agents.

## Accounting notes

- `inputTokens` in deliveries comes from `readSessionUsage`, which sums
  `payload.event.usage.input_tokens` per model call in the session log.
  Cached/prompt-cache tokens are tracked separately in the muse logs and are
  **not** included in the delivery `inputTokens`.
- `outputTokens` is the sum of `output_tokens` across model calls.
- 4 deliveries have no token counts because the session ended in a 429 before
  any `model_completed` event was written.
- Token counts are "logging, never a reason to fail a station": a station can
  be `done` with no count, or `failed` with a count, without contradiction.

## Recommendations

1. **Quota, not code, is the current blocker.** Seven stations failed on 429;
   the factory is paused until 19:30 UTC and the long reset is 23:11 UTC.
   Expect the two in-flight muse processes to finish, then the factory to
   probe; new dispatch will not start until a probe succeeds.
2. **Builder context is the cost driver.** Single builder runs reach 80–290M
   input tokens. Consider trimming what the builder re-reads (prior context,
   whole-repo scans) or capping builder context, since planner/sme runs are
   ~100× cheaper.
3. **No delivery token counts for quota failures.** If you want cost visibility
   into failed runs, `readSessionUsage` could be extended to sum partial
   usage from `model_completed` events that did land before the 429.
4. **Cached tokens (82M in factory) are not billed as input** in this accounting;
   the muse-wide cached figure (1.9B) suggests prompt caching is doing real
   work and is worth keeping enabled.
## Addendum — providers (later)

Deliveries now also record `provider`: stations can run on other CLI
runners than muse (`agy`, `gemini`, `claude`, `codex`), each its own
subscription. Token accounting above is muse-session-log based; Claude
Code deliveries take usage from their JSON output, and text-output
providers record no token count (logging only, never a failure reason).
When a provider's quota is exhausted mid-task, the station fails over to
the owner's backup chain instead of pausing the whole factory.
