# anti-slop (miqdadbadjuber/anti-slop) — evaluation for our review gate

Evaluated at v3.2.24 (MIT, ~7.6k stars). Read: `antislop.md` (745 lines), the seven
`skills/**/SKILL.md` files (~1.8k lines), the installer, the CI, and the
`references/` folders.

**Verdict: take 3 things, take 1 file almost verbatim, refuse the rest.**

It is a well-built, honestly-scoped ruleset — but it is a *UI/copywriting* filter
wrapped in a *skill installer*. We run headless stations with PASS/REJECT
verdicts and no human in the loop; most of its machinery assumes a chat session
with a person in it. The transferable core is small and genuinely missing from
our gate: **comment hygiene, fabricated-claim detection, and a deterministic
"cheap UI defect" scanner.** Those are worth adopting as code, not as a skill.

Do **not** install it (`npx antislop-ai`, `/plugin`, `npx skills add`). Reasons in
§3 — the first one would break the night shift.

---

## 1. What it actually is

| Part | What it is | Value to us |
| --- | --- | --- |
| 40 rules, R-01..R-40, 3 tiers | Hard Gate (absolute) / Purpose-Gate (technique + written reason) / Quality Locks (consistency) | The tiering is good design; ~25 of the 40 are irrelevant to a backend diff |
| Delivery Gate, 4 blocks | A mandatory PASS/FAIL report with per-item evidence, run before delivering | **Directly compatible** with our reviewer card format; the evidence bar is better than ours |
| 7 skills | core, ui, copywriting, human (a11y), layoutmobile, code (comments) | `antislop-code` is the only near-perfect fit for us |
| Two usage modes (`during`/`after`) | First thing every session: **ask the user which mode** | Fatal in a headless station (§3.1) |
| `contrast-check.py` | 168-line dependency-free WCAG ratio checker, self-testing | Small, real, stealable (§4.3) |
| Installer / plugin doors | Writes skills dirs + `AGENTS.md` pointer blocks + `~/.config/antislop/settings.json` | Refuse (§3.2) |
| `DESIGN.md` / liveliness dials | Direction input + ENERGY/RHYTHM/MOTION | Only relevant if we ever ship owner-facing marketing pages |

Its own framing is honest and matches ours: *"a filter, not a style guide"*, *"this
is a diagnostic scan, not a ban list"*, *"the fix is never 'add more bans'"*.
That is the same discipline as `PATTERNS.md`. The difference is that our gate is
enforced by code and theirs by prose.

---

## 2. Where it is better than us

Only two places, and both are about the *shape* of a rejection:

1. **Every rule has an ID and a tier.** A critique can be quoted as
   `R-26 (Hard Gate): this button has no handler`. Our reviewer constraints say
   "quote against the diff" but the reviewer has to invent the taxonomy, so
   critiques are not comparable across rounds or tasks. Rule IDs make rejections
   attributable and let us measure which ones recur.
2. **"Evidence over claims" (C-5, R-35, R-36, R-40).** Their gate forbids PASS
   without a recorded click-through, and forbids *any* unmeasured number
   ("Lighthouse 98", "300% faster"). We have no equivalent: a builder can write
   "improves latency" into a delivery and nothing checks it. Our `verify` gate
   proves code health, not claim honesty.

Where we are ahead and should not regress: our `review-scan.ts` suppression
scanner has no counterpart there at all, and our ratchet discipline
(suppressions as explained baseline, `REVIEW.md` as a snapshot not a gate) is
stronger than "all answers must be no".

---

## 3. Why it must not be installed as-is

### 3.1 The mode question blocks an autonomous station

`skills/antislop/SKILL.md` §"Two Usage Modes" (lines 91–111): if no
`~/.config/antislop/settings.json` exists, the agent **ends its turn** and waits
for the user to answer `1` or `2` before doing *any* review work — explicitly
"even for read-only requests". In a Muse station that is a stalled session:
reviewer card → question → `isBlockedReply` → task parked in `needs-input`. Every
task. The workaround (`npx antislop-ai --mode during`) writes a *global,
cross-project* settings file — one host-wide switch that silently changes
behaviour for every repo the factory touches.

### 3.2 The installer mutates our environment

`cli/lib/install.mjs` writes skill folders into `.opencode/skills` or
`~/.config/opencode/skills` **and** appends a pointer block to `AGENTS.md`
(project or `$HOME`). The global variant loads antislop into *builder* stations
too, where it is actively harmful (it would ban em dashes and demand
`DESIGN.md` in unrelated backend work), and `--update` re-writes those blocks.
This contradicts our decision that conventions bind through `PATTERNS.md` +
`decisions.md`, not through an installed third-party persona.

### 3.3 A naive whole-repo gate would reject our own product

Measured on our tree just now:

| Signal | Occurrences |
| --- | --- |
| Em dash `—` (R-02, **Hard Gate**) | 288 lines in `src/`, 107 in `dashboard/src`, 12 in `public/`, 22 in `demo/` |
| Banner comments (`// =====`, `// ---- X ----`, R-31) | 15 |
| `prefers-reduced-motion` (R-39) | 1 |
| `aria-label` (R-39) | 8 |
| `role="button"` / clickable divs (R-39) | 0 |
| `<img>`, `alt=` (R-39/R-40) | 0 / 0 |
| `outline-none` (R-32) | 1 |

R-02 alone fails `public/index.html` and the dashboard on the first scan. So the
only honest adoption is **added-lines-only, ratchet-style** — exactly how
`review-scan.ts` already works — never a tree-wide gate.

### 3.4 Most of the 40 rules are UI-only

R-01..R-30 are colour, gradients, icons, glassmorphism, badges, bento grids,
pricing tiers, testimonials, hero sections. Our product is a headless pipeline
plus one dashboard; the wizard generates Nix/config, not landing pages. Handing a
backend diff a 40-item UI checklist costs tokens and invites a reviewer to REJECT
for an irrelevant item — the same failure mode we already fixed in
`REVIEW.md` finding 3 (prompts that claim things that did not happen).

### 3.5 Its `after` workflow conflicts with our loop

Mode 2: write `anti-slop/audit-001-YYYY-MM-DD.md`, numbered findings, *do not touch
anything until the user approves numbers*. Our review station must return
verdicts, and critiques bounce to the builder automatically. Importing the
"wait for approval" step would deadlock the pipeline; we already have that
concept in `critiques` + the judge. Their file-based audit is redundant.

---

## 4. What to integrate

### 4.0 Where each check runs: three tiers, not one reviewer

The real choice is not "one more agent or one more card line". A check belongs to
the cheapest tier that can enforce it, and only the residue gets an agent.

| Tier | Who runs it | Cost | Power to stop the line |
| --- | --- | --- | --- |
| 1. Scanner | no agent — `review-scan.ts` style | zero tokens | none (evidence in the card) |
| 2. `craft` station | own role, own card, own session | 1 session, **only when triggered** | narrow veto, `CRAFT-GATE:` prefixed |
| 3. SME + coder reviewers | unchanged | unchanged | full veto |

**Tier 1 must not become an agent.** Regex-checking `// =====` or `href="#"`
with an LLM costs a session, is non-deterministic (it will miss a third of them
and invent a few), and produces a verdict we cannot test. Everything in §4.1 and
§4.2 is deterministic, so it stays a scanner whose report is *evidence, not a
gate* — the exact contract `review-scan.ts` already has.

**Tier 2 should be a separate station — but not for the reason "pollution".**
Station contexts are already isolated: `runStation` spawns a separate process and
sessions are keyed `(jobId, stationId)`, so nothing leaks between the builder and
the reviewers today. What adding the ruleset to the coder reviewer card would
actually damage is narrower and more real:

1. **The reviewer payload diet** — already an explicit design goal in
   `dispatch.ts` ("Reviewer payload diet: execution brief plus diff stat … instead
   of the full plan"). The card is ~900 chars and 14 labelled sections before the
   persona; a 12-line aesthetic ruleset plus a findings list pushes the actual
   diff further down the one context the reviewer has.
2. **The coder's identity** — "a code reviewer" that also adjudicates copy makes
   its critiques unfalsifiable: a REJECT no longer says *which* standard failed.
   A separate role keeps each findings list attributable, and lets the owner tune
   one lane without touching the other.
3. **Routing** — craft review is pattern-matching, so it belongs on
   `muse-spark-1.3` at `low`, not on the coder's `high`. `STATION_ROUTES` makes
   that a one-line decision, but only if it is its own role.
4. **Its own session memory** — keyed by station id, the craft reviewer resumes
   across rounds, so round 2 can verify "did the builder address my point"
   instead of re-listing from scratch. That is the same benefit the red-team
   re-review already gets.

**It is not a peer reviewer with an unlimited veto — it is a gate with a four-item
veto.** Every REJECT feeds `critiques`, which bounces the builder, and
`maxReviewRounds` is 2, so a cosmetic finding can consume the entire budget and
land the task at the judge, then at the owner. A style reviewer with that power
stops the night shift for nothing.

**Owner decision (locked): the four-item veto is live from day one, not after a
proving month.** That is safe here for one specific reason: all four items are
*decidable*, not tasteful — the scanner can already see three of them, so the
reference implementation of the check exists and the reviewer is confirming, not
inventing. A retro-points probation would only be right for judgment calls, and
none of the four are judgment calls.

The veto is a closed set, and the parse rejects anything outside it:

| ID | Predicate (the reviewer must name one) | Not this |
| --- | --- | --- |
| `DEAD-CONTROL` | a control the diff adds that a user can activate and nothing happens: `<button>` with no handler and no submit role, `<a href="#">`/`href=""`, `onClick` on a non-interactive element with no role | disabled / `aria-disabled` controls, form-submit buttons, anything the diff labels as an honest placeholder |
| `FAKE-CLAIM` | user-facing text asserting a metric, compliance, customer or performance fact with no source in the same diff (`99.9%`, `10K+`, `Nx faster`, `SOC 2`, `ISO 27001`, `uptime`, `enterprise-grade`, `trusted by`), or any number in a delivery without the command and output that produced it | numbers in tests, fixtures, logs, or quotes attributed to a real source |
| `GHOST-LINK` | a navigation target that does not exist: `href="#id"` with no such `id` in the diff or tree, `href="/path"` with no route or served file, a nav item to a page the diff does not create | external URLs, `mailto:`, targets that exist outside the diff and are verified in the tree |
| `SCRIPT-PATCH` | a diff that adds a script whose purpose is rewriting source, CSS or HTML by string replacement instead of editing the file in place | formatters (biome/prettier), one-shot codemods whose *output* is committed, generated-file tooling declared in `PATTERNS.md` |

Mechanics, so the veto stays narrow without a human policing it:

- **Line 1:** `PASS` or `REJECT`, exactly like every other station.
- **A critique enters `critiques` only as `CRAFT-GATE:<ID>: …` with one of the
  four IDs above.** An unknown ID, or a `CRAFT-GATE:` line with no ID, is
  demoted to a retro point. A reviewer cannot invent a fifth category, and a
  reviewer that drifts into taste produces retro points, not bounces.
- **Everything else is filed as a retro point** (reusing
  `MAX_RETRO_POINTS_PER_TASK`), which is the mechanism this repo already trusts
  for "true, worth doing, not worth stopping the line".
- **Vetoed items are not re-litigable as taste.** A craft `REJECT` goes to the
  builder with the quoted line and the quoted predicate; if the builder disputes
  it, it reaches the judge like any other critique — but the four predicates are
  evidence-checkable, so most of these resolve at the diff.

That parse is the same shape as the existing `verdictOf` / `isBlockedReply`
helpers, so it adds no new control flow to the review loop — only a stricter
`verdictOf`-style reader with a closed vocabulary.

**Lane interaction:** the craft station is a *gate*, not a reviewer, so it runs on
both lanes when triggered. A fast-lane task keeps its "single review" (the coder)
and still cannot ship a dead control. Say this explicitly in the card so the
reviewer does not think it is the fast lane's second opinion.

**The rules live in a file, not in the card.** Put the subset in the repo
(`docs/craft-rules.md`, or a `PATTERNS.md` section) and have the card inline only
the four `CRAFT-GATE` items plus the file path for depth. That is antislop's own
discipline ("skills reference the core rules by number and never duplicate them")
and it matches README point 1: context lives in files, not in a chat prompt.

**Cost in code, all compiler-enforced:** `JobCard.role` is a closed enum (8
values) and `STATION_ROUTES` is `Record<role, …>`, so a new role will not
typecheck until it is routed — the type system will list every place to touch
(dashboard station display, Settings route table, demo, tests). That is a
feature, not a tax.

Ordered by value per line of code. P0 items are deterministic — they cost zero
reviewer tokens, which is the same argument that justified `review-scan.ts`
("a check no AI has to read files for must not cost tokens").

### 4.1 P0 — `src/crew/comment-scan.ts` (Tier 1, from `antislop-code`, ~150 lines)

Our biggest real gap. `PATTERNS.md` governs names, types, complexity and
suppressions, but says nothing about comment quality, and the coder reviewer is
not told to look. `antislop-code` is 90% aligned with our existing stance
("explain why", "every silence carries a reason") and adds a precise, checkable
list.

Detector on **added lines only**, comment-bearing files only (`.ts .tsx .js .jsx
.py .rs .go .sh .css`):

| Pattern | Marker |
| --- | --- |
| `^\s*(//\|#\|/\*)\s*(=\|-|─\|━\|#){3,}` or ALL-CAPS banner | decorative separator |
| `// Step 1:`, `// First,`, `// Next,`, `// Finally,` | workflow narration |
| `// Main logic`, `// Helper`, `// Entry point`, `// Error handling`, `// Core logic` | empty label |
| `// TODO: Improve this`, `// Future improvements`, `// Add more validation` | vague placeholder |
| `// (✅\|🚀\|🔒\|✨\|⚠️)` | decorative emoji |
| `} // end if`, `# End of function` | end marker |
| a comment that restates the next line's identifier/assignment | restating the obvious (report, do not auto-fail) |

Report shape: reuse `formatSuppressionReport`'s shape exactly — `12 comments
scanned, 3 decorative, 1 empty label` plus file:line lines, capped at 30. Feed it
into the reviewer card next to the suppression report, with the same wording:
**evidence, not a gate**.

Scope guardrail copied verbatim from their skill: *never modify executable code
for a comment finding.* That also keeps this out of the builder's lane — it is
review input, and the fix is a builder pass.

### 4.2 P0 — content scanner: claims, filler, dead controls (Tier 1)

Shipped as `src/crew/content-scan.ts`, sharing the diff walker
(`src/crew/diff-walk.ts`) with the suppression and comment scanners so all
three count lines identically and the reviewer never sees two reports disagree
about where a line is.

New `SuppressionKind` is the wrong home; add a sibling `content-slop` hit type in
the same module (it already parses unified diffs and knows string-literal
masking, which matters here — a test asserting on `"seamless"` must not trip the
scanner).

Rules, added lines only, and only in files that can ship user-facing text
(`.tsx`, `.html`, `.md`, `public/**`, and `dashboard/**`):

- **Unmeasured number** (`R-36/R-40`): `99.9%`, `\d+K\+`, `\d+% faster`,
  `uptime`, `Lighthouse`, `SOC 2`, `ISO 27001`, `enterprise-grade` — reported
  unless the same diff contains a measurement artifact (a test, a log fixture, a
  linked run).
- **Testimonial shape** (`R-18`): quote + name + role block in a UI file.
- **Ghost link** (`R-24`): `href="#"` and `href=""` in `public/**` and
  `dashboard/src` (these are always defects for us, no purpose test needed).
- **Dead control** (`R-26`): `onClick={() => {}}` and `<button>` with neither
  handler nor `type="submit"` in a form.
- **Script-applied source patching** (`R-33`): a diff that adds a script
  (`scripts/**`, `*.sh`, `*.py`) whose added lines rewrite `*.tsx|css|html` by
  string replacement. Rare but real, and we have no check for it at all — this is
  the rule I would add even if we took nothing else from the repo.
- **AI marketing vocabulary** (`R-16`): `seamless`, `revolutionary`,
  `next-generation`, `cutting-edge`, `AI-powered`, `game-changing`, `supercharge`,
  `elevate`, `unlock` — *reported, not failed*, since a legitimate product quote
  can contain them.

Note the deliberate omission: **no em-dash rule.** Our own tree is full of them
(§3.3), it carries zero defect information in code comments, and as a Hard Gate
it would make the reviewer reject its own house style. If the owner wants it for
`public/` copy only, it belongs in the owner's style note, not the gate.

### 4.2a Dead controls: two bands, and never a veto from a string match

Measured on `dashboard/src/App.tsx` (4.9k lines, our largest UI file):

| Method | `<button>` found | flagged | real defects |
| --- | --- | --- | --- |
| naive regex, minus `on[A-Z]\w*=` | 83 | 8 | **0** |
| TS AST: no handler, no `type`, no `disabled`, no spread, not inside `<form>` | 83 | 5 | 0 |

The 8 string-match candidates were 2 `disabled` controls and 6 form submit
buttons — **100% false positives**. A veto built on that match would have bounced
every task touching the compose box, and the builder would have been asked to "fix"
a disabled button.

**And the deeper defect: absence of a handler is not absence of behaviour.** The
same is true of `href="#"` with no `onClick` — the handler can be attached at
runtime. Our own tree proves it: `public/index.html` ships
`<button id="loop-prev">Previous</button>` with no handler, and
`public/app.js:58` wires it with `getElementById("loop-prev").addEventListener`,
while line 41 wires every button in a step list with
`querySelectorAll("button")`. A scan of that file would have called a working
control dead.

So Band A cannot be a fact about the line. It can only be a fact about the tree:

| Band | When it applies | May veto? |
| --- | --- | --- |
| **A — provable** | the element has no target/handler **and** the repo attaches no behaviour at runtime (no `addEventListener`, `querySelector` wiring, `.onclick =`, `ref`, `cloneElement`, `data-action`, htmx/Alpine attributes) **and** the element offers no handle a script could grab (`id=`, `ref=`, `data-*`, `{...props}`) | yes |
| **B — candidate** | everything else, including every interactive finding in a repo that does wire at runtime | no — shortlist, reviewer confirms |

Which means: in *this* repo, interactive findings are **always Band B**, because
`dashboard/src/App.tsx`, `public/app.js`, `status/index.html` and
`dashboard/server.ts` all attach listeners. A repo with no runtime wiring at all
(most Go/Python/CLI projects, and small static pages) gets Band A for free. The
probe runs once per review, not per line: `runtimeWiringIn` greps the worktree,
and a failed search counts as *wired*, because the candidate band is the safe
band.

What a string match cannot see, all of it present in our own UI:

- `{...props}` spread supplying the handler later
- `disabled={…}` — a control that is correctly inert
- `type="submit"` and `<form>` ancestry
- event delegation on a parent
- `<Button onClick>` custom components that forward the prop
- `<a href>` vs router `<Link to>` — a router link has no `href` at all

Band B exists because a shortlist is the honest output of a token scan. It costs
the reviewer one glance; it cannot cost the builder a wasted round.

**Consequence for the veto:** `DEAD-CONTROL` still ships live, but the reviewer's
evidence is now "no target or handler, and the wiring search found nothing",
never "the JSX has no `onClick`". In a runtime-wired repo that means naming the
search (`rg 'addEventListener|querySelector|onclick|data-action'`) and its
result — the same discipline the suppression scanner already demands, applied to
behaviour instead of silences.

**For this repo specifically, the AST version is available and better.**
`typescript` is already a dependency, and `eslint.config.ts` already hosts one
custom AST rule (`no-unrestored-spy`) with a hand-rolled node interface — so a
`no-dead-control` rule is idiomatic here. But that config is deliberately minimal
and currently scoped to test files, so the cheaper home is a `scripts/` check run
from `verify` (`createSourceFile` over `dashboard/src/**`). Two caveats: it is
JS/TS-only, so it cannot be the factory's check; and do not build the factory
scanner on the TS compiler API — in this environment bun and node already resolve
two different `typescript` builds, and TS 7's native compiler did not expose
`createSourceFile` at all (the default-import object had none). The factory
scanner stays token-level and portable; the AST path is a repo-local upgrade that
upgrades Band B candidates to Band A.

### 4.3 P1 — the `craft` station (Tier 2, from `antislop-human`)

Spawned only when a static trigger fires: the diff touches `dashboard/src/**`,
`public/**`, or files whose added lines the §4.1/§4.2 scanners already flagged
for comment or copy slop. Backend-only diffs never pay for it. Static files
(`.ts/.py/.go/.rs`, no UI path) get Tier 1 only.

Its card carries the statically checkable subset of `antislop-human` — six items,
inline, because they are one line each:

accessible name on icon-only buttons, `<img alt>`, `<label>` for every input,
visible `:focus-visible` (and no `outline: none` without a replacement),
`cursor: pointer` on enabled controls, `prefers-reduced-motion` honoured.

Plus vendor `contrast-check.py` into `scripts/contrast-check.py` (MIT, keep the
header and licence) and run it against changed colour pairs when a diff touches
CSS/theme tokens — `git diff` → extract `text-*/bg-*` pairs is too fuzzy for P1;
start with "any new hex pair in a theme file must be checked by the builder and
the ratio pasted in the delivery".

`antislop-layoutmobile` is prose without a checker. Skip it: our responsive risk
is real but not mechanisable, and the reviewer already inspects the diff.

Note what this tier deliberately does **not** inherit: the 40-rule Delivery Gate
and the liveliness dials. The craft station judges defects, not taste, because
that is the only thing its verdict can be held to.

### 4.4 P1 — Delivery gate additions (`R-35`, `C-5`)

Two small additions to the existing delivery/morning-report path, no new
machinery:

1. **Claims must be measured.** If the delivery text asserts a number or a
   measurable improvement, the delivery carries the command and output that
   produced it, or the claim is removed. (We already store verify output; this
   just makes the assertion traceable to it.)
2. **Click-through evidence for UI tasks.** When `testMode === "dev"` and the
   diff touches UI, the builder's success criteria already allow a Playwright
   run; make the *recorded element list* ("Signup → /signup, empty form →
   validation") the deliverable, and let the reviewer REJECT a UI PASS without
   it. This is R-35 and it is the single most useful sentence in the repo.

### 4.5 P2 — `PATTERNS.md` section, then a `decisions.md` entry

Add one section, "Comments explain why, and only why", with the 8 patterns from
§4.1 plus the preserve-list (business rules, workarounds, security, concurrency,
protocol detail, licences) and the length cap: *one line, two only when the
second carries a new fact.* Then record it in `decisions.md` per our own rule
that conventions are decisions, and point the coder-reviewer constraint at it
(`PATTERNS.md` is already the referenced contract — no new file to load).

Reconcile one conflict on the way in: the repo requires every suppression to
carry a reason **in the line**; antislop-code wants comments short. Both hold —
the reason must be one line, not a paragraph. Say so explicitly in the section.

### 4.6 Explicitly refused

- The installer, the plugin doors, the `AGENTS.md` pointer, the global settings
  file.
- The mode question and the `audit-00N.md` approval workflow.
- The 40-rule Delivery Gate as a gate. It stays a *source of rule IDs*.
- `R-37` (DESIGN.md required), the liveliness dials and the Purpose-Gate group:
  they presuppose we are designing a marketing surface. Revisit only if we
  start generating `public/`-style pages as a deliverable, and then only for
  that task type.
- `antislop-copywriting` wholesale — its em-dash and buzzword bans are the parts
  worth having, and those are in §4.2.

---

## 5. Mapping: their rules → our stations

| Station / artifact | Their rule | Status today |
| --- | --- | --- |
| Builder card | `R-33` no script-patching source | **missing** — add to §4.2 scan |
| Builder card | `R-35` verify before deliver | covered by final verify, but not for UI click-through |
| Builder card | `R-31` one-line reason per decision | partially covered (`PATTERNS.md` suppressions only) |
| Scanner (Tier 1) | `R-31`, `antislop-code` | **missing** — §4.1 + §4.5 |
| Scanner (Tier 1) | `R-36`/`C-5` fabricated claims | **missing** — §4.2 |
| `craft` station (Tier 2) | `R-39`, `R-25`, `R-32` | **missing** — §4.3, UI diffs only |
| Coder reviewer | — | unchanged by design (§4.0) |
| SME reviewer | `C-3`/`C-5` content serves the product | partially: persona + project rules |
| Red-team | `C-1` intentionality | covered in substance (evidence-per-line critique) |
| Final gate | `R-35` | covered (`effectiveVerifyCommand`), plus §4.4 |
| Suppression audit | — | **we are ahead**; nothing to take |
| Morning report | `C-5` | add claim traceability (§4.4) |

Net: of 40 rules, **6 are worth importing** (`R-33`, `R-35`, `R-36`, `R-39`,
`R-31`, plus `R-26`), 2 are already covered better by us, and the rest are
UI-decoration rules for a product we do not ship.

---

## 6. Cost and sequence

| Phase | Tier | Work | Files | Est. | Status |
| --- | --- | --- | --- | --- | --- |
| P0a | 1 | comment scanner + tests + reviewer-card report | `src/crew/comment-scan.ts` (+ tests), wired in `dispatch.ts` | ~0.5 day | **shipped** |
| P0b | 1 | content scanner: claims, filler, dead-control bands | `src/crew/content-scan.ts`, `src/crew/diff-walk.ts` (shared walker) (+ tests), wired in `dispatch.ts` | ~0.75 day | **shipped** |
| P1a | 2 | `craft` role + card + `CRAFT-GATE:` parse + trigger | `jobcard.ts` enum, `orchestrator.ts` route, `dispatch.ts`, `dashboard/`, `demo/` | ~1 day | next |
| P1b | 3 | claim traceability + click-through evidence | builder card, delivery text, `REVIEW.md`/`PATTERNS.md` note | ~3 h | — |
| P2 | — | `PATTERNS.md` section + `docs/craft-rules.md` + `decisions.md` entry | docs only, owner approves | ~1.5 h | — |

Every phase is additive and reversible; none touches the verify gate, so a
mistake costs review noise, not red builds.

**Recommended order:** P0a + P0b first, as one commit, with the reviewer-card line
worded exactly like the existing one — *"report is evidence, not a gate; the
reviewer can still inspect"* — so the new scanners inherit the suppression
scanner's contract and cannot fail a task on their own.

Then P1a. Two separate strictness decisions, and the owner has already made the
second one:

- **Tier 1 stays report-only** for the first few tasks: read what it actually
  flags on our tree (15 banner comments, 288 em dashes in `src/`, 8 `aria-label`s
  in the dashboard) before deciding whether comment findings should ever fail a
  diff. A scanner that starts opinionated is how a reviewer earns a reputation
  for noise.
- **Tier 2's four-item veto ships live from day one** (owner decision). It does
  not need the calibration window because each item is a predicate over the diff,
  not a judgment about style — and three of the four are already visible to the
  Tier 1 scanner, so the reviewer is confirming a machine finding rather than
  forming an opinion.

P1a needs a `decisions.md` entry **before** it lands, since it adds a station to
qualifying review rounds and introduces a veto surface; P2 records the rules it
reads.

---

## 7. Open questions for the owner

1. **Em dashes:** adopt `R-02` for `public/` copy only, or keep our house style?
   (My recommendation: keep. It is a voice choice, not a defect, and we use them
   in 400+ places.)
2. **Comment scanning scope:** fail the diff or report-only for the first N
   tasks to calibrate against our existing 15 banner comments?
3. ~~Craft station veto scope~~ — **decided: the four-item veto ships live from
   day one** (`DEAD-CONTROL`, `FAKE-CLAIM`, `GHOST-LINK`, `SCRIPT-PATCH`), with
   any other `CRAFT-GATE:` line demoted to a retro point. Recorded in
   `decisions.md`.
4. **Is UI work common enough** to justify §4.3 now, or is it a "when the
   dashboard is next touched" item?
