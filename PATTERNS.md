# Patterns and code conventions

How this repo wants code to look, and which design patterns we lean on.
Two audiences: agents writing code here (this file is their contract) and
the coder reviewer, which checks every diff against it.

Mechanical rules live in `biome.json` and are enforced by `bun run verify`.
This file covers the semantic part that no linter can check.

## The loop: write, fix, verify

```bash
bun run fix        # Biome formats + applies safe fixes (the only auto-fix step)
bun run check      # Biome + ESLint, no writes
bun run coverage   # tests with coverage report
bun run verify     # typecheck + coverage + lint + suppression audit; the gate
```

Rule of thumb: **the agent writes, `fix` makes it canonical, `verify` proves
it.** Never hand-format; never commit before `verify` passes.

## Verification is fluid, not one hardcoded command

The factory picks a project's gate from what the repo already is
(`detectProjectStack` in `src/crew/dispatch.ts`), and the builder can
propose a stricter command; the owner always overrides.

| Repo says (manifest) | Station runs |
| --- | --- |
| `package.json` with a `verify` script | `<pm> run verify` under the detected manager (bun/npm/pnpm/yarn) |
| `Cargo.toml` | `cargo test` (add `cargo clippy -- -D warnings` in CI for the lint half) |
| `go.mod` | `go test ./...` (add `go vet ./...` in CI for the lint half) |
| `pyproject.toml` / `requirements.txt` | `pytest` when pytest is a dependency, else `python -m unittest discover` |
| nothing recognizable | no guessed command — the builder proposes, the owner confirms |

A JS repo must *state* its gate (the `verify` script); a compiled repo gets
its canonical check command. Either way, "no stored command" no longer means
"nothing to prove". `scripts/project-gates.sh <repo>` ports the JS configs
into another checkout and prints the per-stack notes.

## Formatting is chosen for diffs, not for bikeshedding

`biome.json` sets `lineWidth: 100`, `trailingCommas: "all"` and
`expand: "always"`. Every array and object is one entry per line, so adding
an element is a pure addition (+1 line, +1 comma) instead of a reflow of
lines a reviewer already read. This is deliberate: LLM-written code is
reviewed as a diff, so the diff must stay additive.

Do not fight the formatter. If a layout is unreadable, extract a variable or
a function — do not reformat around the problem.

## Complexity ceilings

- Cognitive complexity: **15** per function (`complexity/noExcessiveCognitiveComplexity`).
- Function length: **120** lines, blank lines excluded (`complexity/noExcessiveLinesPerFunction`).

Existing hotspots carry `// biome-ignore lint/complexity/... : baseline ...`
comments — 96 suppression markers at the last audit, 0 unexplained
(`bun scripts/suppressions.ts --audit` is the single source for this
number; do not hand-count it here). They are a ratchet, not a permission:

- Removing one is always welcome (boy-scout rule: touch the function, split it).
- Adding one requires the owner's agreement and a line in `decisions.md`.
- Never suppress a new violation to make `verify` green.

When a function trips the ceiling, reach for the patterns below before
reaching for a suppression.

## Silencing a check is a decision — say why, in the line

An agent that finishes a task by silencing the complaint (skip the test,
ignore the rule, `@ts-ignore` the type) has not finished the task. Every
silence must be a visible, explained decision:

- `// biome-ignore ... : <reason>` — the reason is mandatory.
- `// eslint-disable-next-line ... -- <reason>` — mandatory.
- `// @ts-expect-error <reason>` — mandatory.
- `test.skip(...)` / `it.skip(...)` — allowed only with a `// <reason>` and
  only when the suite cannot run it; the reviewer confirms against the diff.
- `test.only` / `.only` / `fit` — never ships. Nothing justifies focus
  leakage; the reviewer REJECTs it.
- Baseline ratchet entries are the one exception: their reason is
  `baseline: ...`, recorded in `REVIEW.md`, and only the owner may add one.

The static scanner (`src/crew/review-scan.ts`, `scripts/suppressions.ts`)
finds every suppression a diff **adds** and marks the unexplained ones, so
this check fires without an AI reading files:

- `bun scripts/suppressions.ts --audit` — repo hygiene: every suppression
  in the tree carries a reason; runs inside `bun run verify`.
- `bun scripts/suppressions.ts --diff <file|-|--base REF>` — the review
  view: what this diff added.
- The review station embeds the same scan in every reviewer card, and an
  unexplained suppression is a REJECT reason unless the diff itself shows
  why it must stay.

## Types: closed sets get one name, and everyone uses it

The compiler should catch a mistake while the code is being written, not
when a payload happens to arrive with an unexpected string.

- Declare each closed set once, in one place, and derive the type from it:

  ```ts
  export const TASK_STATES = ["planned", "running", "needs-home", "done"] as const;
  export type TaskState = (typeof TASK_STATES)[number];
  ```

  New code that models a state machine should prefer a real `enum` (or a
  const object) with exported members, so call sites read
  `TaskState.Done` and a rename is a compiler error rather than a grep.
- **Never re-type a literal that has a name.** If a value exists in a
  closed set, pass the member (or the spread of the array), not `"done"`.
  Raw strings belong only at parse boundaries (zod schemas) and in tests
  where the literal itself is the subject under test.
- Validate at the boundary, then work in typed values: `zod` for files,
  JSON, HTTP and CLI input. File/JSON data is never `as`-cast (the
  `no-object-literal-as-cast` GritQL plugin enforces part of this).
- Use `unknown`, not `any`, for data that has not been parsed. `any` at an
  API boundary is a deliberate, documented exception — see `api()` in
  `dashboard/src/App.tsx`.
- Booleans read as predicates: `isOpen`, `hasPlan`, `canRetry`, `shouldPark`.

## Naming and structure

`style/useNamingConvention` enforces the mechanical part: PascalCase types,
camelCase variables/functions/parameters, CONSTANT_CASE or camelCase
constants, camelCase class members. Object-literal properties and external
payload keys are intentionally **not** enforced: an API that speaks
`session_id` keeps speaking `session_id`, and the adapter translates.

Beyond that:

- One responsibility per module. If a file is about to become the only
  place everything touches, it is a god module — split it at the seams you
  already have (route table, view, store).
- One public function per concept. Name the intent, not the mechanism:
  `landTaskWork`, not `doMergeAndPushStuff`.
- Prefer composing small named functions over deep `if` ladders. A guard
  clause per condition beats nesting.
- Keep the boundary between "what the owner said" (prompt, task record)
  and "what the code decided" (plan, delivery, retro) visible in types.

## Gang of Four patterns we already use (and where)

Patterns are vocabulary, not decoration. Use these where they already fit;
do not force a pattern into a file that does not need one.

| Pattern | Where | Why it is there |
| --- | --- | --- |
| Command | `src/crew/jobcard.ts`, `store.writeCard` | A station invocation is a persisted data object: retry, resume and audit without replaying a chat. |
| Strategy | `builderRoute` in `src/crew/dispatch.ts`; `MUSE_PRESET` in `src/crew/orchestrator.ts`; reviewer selection by lane | Model/effort and review depth are swappable policies, chosen per attempt and per triage lane. |
| Template Method | `runTaskPipeline` in `src/crew/dispatch.ts` | Fixed skeleton (worktree → plan → red-team → build → review → land) with steps that vary by lane and tier. |
| State | `TASK_STATES` in `src/crew/task.ts`; `landTaskWork` verdict (`done \| parked \| held`) | Transitions are explicit values, so restart and the dashboard agree on where a task is. |
| Observer / pub-sub | Station log buffer in `src/crew/orchestrator.ts`, consumed by `/api/stations/:id/stream` in `dashboard/server.ts` | The dashboard observes a running station without owning its state; reconnect replays from a sequence id. |
| Factory Method | `scripts/wizard.ts` targets (`incus`, `existing`, `clean`, `cloud`), `src/scaffold.ts` | Every target produces the same artifact set behind one shape; the caller does not build files by hand. |
| Adapter | `src/crew/preset.ts` (`describeMuseLine`, `parseMuseOutput`) | Muse's JSONL is translated once at the edge into the internal event vocabulary. |
| Chain of Responsibility | `src/governance/gates.ts` and `governance/hooks/*` | Clarification → redteam → plan-mode each get a chance to deny, and each verdict is attributable. |
| Facade | `FactoryStore` (`src/crew/store.ts`), `dashboard/server.ts` | Files/JSONL/SQLite complexity stays behind one small API; callers do not learn storage layout. |
| Memento | `planBaseCommit`, `decisionsBaselineHash`, `decisionsAckHead` in `src/crew/task.ts` | A task remembers the exact main state it was planned against, so staleness is provable instead of assumed. |

Where the codebase does **not** use a pattern, do not introduce one just
to check a box. The reviewer's question is "does this diff make the
existing seams clearer?" — not "which pattern is missing?".

## Review gate

The coder reviewer receives every diff with the constraint to check it
against this file, plus a machine-generated suppression report (added
silences, with and without reasons). A violation of the mechanical rules
fails `verify` already; a violation of the semantic rules above — or an
unexplained suppression — is a REJECT reason, quoted against the diff, not
against taste.

## Changing this file

Conventions are decisions. A change here is a `decisions.md` entry, and the
owner approves it before it binds anyone. Ratchets may be tightened without
asking (lower complexity, stricter naming); loosening always asks.
