# Decisions

## Authority

- The owner's stated requests and decisions are authoritative.
- Agents may question a stated request, but must not reject it merely because the owner has not provided measured evidence about their own experience.
- If code or facts significantly contradict a request, agents should surface the contradiction with evidence.
- If a request conflicts with a decision recorded in this file, agents must surface the conflict instead of silently overriding the recorded decision. The recorded decision remains binding until the owner explicitly revises it here.
- When the owner explicitly revises a decision in this file, the newest revision replaces the older entry.

## Pickup after main moves

- When main moves under a task that has uncommitted work in its worktree, the factory commits and saves that work and rebases it onto the new base by default. It does not ask the user.
- Exception: secret-like files (.env files, private keys, credential stores) are never auto-committed. Their presence — or a rebase conflict — parks the task for the owner, with any saved commit left intact.
- If that save-and-rebase hits a rebase conflict, a fixer agent resolves it automatically (keeping both sides; main's edits applied to files the task moved). The owner is asked only when the conflict involves secret-like files or the agent resolution itself fails; mechanical checks (clean tree, no rebase in progress, new base is an ancestor) decide success, not the agent's word.
- The same applies when the factory's save commit itself fails (index lock, hook, nothing staged): the failure is classified separately from a rebase conflict, and the fixer agent stages, commits, and rebases the work; the owner is asked only if that also fails.

## Decisions-file changes are checked early, in stated order

- When a task is stated, check then — at stating/planning time — whether it needs a change to this file. Do not discover that need when the task finishes.
- The order tasks were stated in is the implementation sequence. Needed decisions-file changes are applied once, sequentially in that stated order, early — before the sequence's implementation picks them up — not re-opened task by task as each one completes.
- One task completing does not by itself reopen this file for every other task. Other tasks pick up the settled file; only an actual contradiction with a task's plan parks that task for the owner.

## Code health is a gate, not a review opinion

- `bun run verify` (typecheck, tests with coverage, Biome check, ESLint) is the only definition of "done" for this repo. A green run is required before a task is reported done.
- Biome is the canonical formatter and fixer. `bun run fix` is the only auto-fix pass; formatting is chosen so diffs are additive (one array/object entry per line, trailing commas, line width 100).
- Cognitive complexity is capped at 15 per function and function length at 120 lines. Pre-existing violations are suppressed as a ratchet with a reason; adding a new suppression requires the owner, removing one never does.
- The coder reviewer checks every diff against `PATTERNS.md`. A semantic violation (a closed-set literal instead of its named member, a god module, a forced design pattern) is a REJECT reason, quoted against the diff.
- Coverage is measured on every run. A hard threshold is armed only after the dashboard UI has tests; until then the baseline is recorded in `REVIEW.md`.
- Silencing a check is a decision, not a shortcut: every disabled lint, skipped test or type opt-out a diff adds must carry a reason in the line itself. The suppression scanner reports the unexplained ones to the reviewer, and an unexplained suppression is a REJECT reason. `.only`-style test focus never ships.
- Verification is fluid per project, not one hardcoded command: JS repos must state a `verify` script (run under the detected package manager); cargo/go/python repos are verified with their canonical test commands. The builder may propose a stricter command; the owner always overrides.

## Review finds defects; a craft gate may stop the line for exactly four

- The review stage judges the diff, not taste. A separate `craft` station reviews work only when the diff touches UI or copy surfaces. It does not replace the SME or coder reviewer, and on the fast lane it is a gate rather than the second reviewer.
- Its veto is a closed set: `DEAD-CONTROL`, `FAKE-CLAIM`, `GHOST-LINK`, `SCRIPT-PATCH`. A critique enters the builder loop only as `CRAFT-GATE:<id>: ...` naming one of those four. Any other finding — and any `CRAFT-GATE:` line without a recognised id — is filed as a retro point instead of bouncing the builder.
- Each id is a predicate over the diff, never a style opinion: a control the diff adds that does nothing when used; a user-facing claim with no source in the same diff; a navigation target that does not exist; a script that rewrites sources by string replacement instead of the file being edited in place. A finding that cannot be quoted against one of those predicates is not a veto.
- A static scan may produce candidates, but only a finding it can prove may back a veto. For dead controls, absence of a handler in the diff is not proof: behaviour can be attached at runtime (`getElementById(...)` + `addEventListener`, delegated `querySelectorAll`, `.onclick =`, a `ref`, htmx/Alpine attributes), and our own `public/index.html` ships a button that works only because `public/app.js` wires it that way. A control is only vetoable as `DEAD-CONTROL` when the repo attaches no behaviour at runtime and the element offers no handle (`id`, `ref`, `data-*`, spread props) — otherwise it is a candidate the reviewer confirms by searching for the wiring.
- The station's rules live in a versioned file in the repo (planned home: `docs/craft-rules.md`). Its job card inlines only the four veto items and points at the file for depth; rules are never pasted into a card wholesale.
- Deterministic checks stay deterministic: comment and copy slop are scanned by code and reported as evidence on the reviewer card, never graded by an AI. Scanner findings are report-only and cannot fail a task on their own.

## Visual changes are approved from screenshots, outside git

- A task that creates or changes pages gets a Visual Review stage after code review and final verify, before Land: the planner declares key moments (`## Visual moments` in the plan), the builder mirrors them as `visual.moments.json`, and the factory screenshots each moment on the base commit and on the feature worktree and pixel-diffs them.
- Changed or new screenshots park the task for the owner: **Approve & land** pins the exact approved screenshot hashes (a re-capture must match), **Request changes** sends per-screenshot comments back to the builder. No visual change passes automatically.
- Screenshots are never committed: baseline, after and diff images live only under the factory data dir (`tasks/<id>/visual/`), outside every worktree and git history. Only the moment definitions live in the repo.

## Minor red-team points are deferred, not bounced

- Every red-team point is tagged `MAJOR` or `MINOR` by the red-team itself; an untagged point on a rejection counts as MAJOR. A rejection with only MINOR points accepts the plan as drafted — no reviser pass, no re-review rounds — and writes the points to the project's deferred list (Inbox-visible, owner-dismissible, never auto-planned tasks).
- When a later task looks related (shared keywords, tags or file paths), each open deferred point returns as a blocking plan question. Include folds it into that plan under a `[deferred:<id>]` marker and closes it; skip leaves it deferred for a future task.

## Model runners are interchangeable subscriptions

- A station's CLI runner is a routing choice, not a constant, organised as presets: complete provider/model/effort sets per station in Settings, in swap order, unlimited in number. Settings suggests presets from the installed agents, including cross-family presets where one model family writes the code and a different subscription checks it.
- On a quota/usage-limit failure a provider is marked exhausted until its reset backoff and the whole factory swaps to the next preset; the station retries there with a fresh session and resume ids are stored per provider, never crossing runners. A preset may also declare critical failure/provider-error rates over recent station outcomes (quota excluded); reaching one skips that preset before spending another call. Only every-preset exhaustion or skipping parks the task as before.
- Caller model overrides that name muse models (tier escalation, judge) apply to muse routes only.
