# Readiness for Meta Global AI Developer Hackathon submission

Assessed against https://dev.meta.ai/events/global-hackathon (submission due
Nov 4, 9:00 PM ET; today Nov 2). Tracks: Indie / Startup. Themes: Build for
Your World, Push the Frontier. Stack alignment: repo is built on Meta's Muse
models (`muse-wonder-1.0` planner/red-team/retro, `muse-spark-1.3` builder/QC)
and Meta's Muse Code agent, invoked via `muse exec`.

## Score: ~70% ready

Core code is green and demoable. Remaining work is packaging/publishing, not
engineering.

### What is solid

- `bun run verify` green: typecheck clean, 302 tests pass, Biome + ESLint clean,
  suppression audit 96 total / 0 unexplained.
- `bun run build:ui` succeeds (dashboard bundle 357 kB).
- `bun run demo` runs end to end: planted fault caught by independent QC,
  fixer reworks, QC passes, rollback shown, morning report printed.
- `bun run start` (showcase, :4317) and `bun run dashboard` (:4319) both boot.
- README has a one-line promise, quick start, layers, models, verify commands.
- `demo/VIDEO_SCRIPT.md` is a complete 3-min storyboard; a recorded
  `demo/recordings/feature-creation.webm` (3.8 MB) exists.
- Self-commissioning wizard (`bun run wizard`) generates, never applies.
- Governance: independent red-team/QC sessions, plan-mode lockout, retro.
- No real TODO/FIXME in source; craft-scan clean on the current diff.
- Secrets: `.env.example` has no secrets; `factory-data/`, `data/`,
  `demo/recordings/` are gitignored; leak-check skips cleanly without terms.

### Blockers to fix before submitting

1. **Uncommitted in-progress work.** `dashboard/src/App.tsx` (+287 lines) and
   new `dashboard/src/features-filter.ts` + test implement a work-order search/
   filter bar. Tests and build pass, so it is functional, but it is uncommitted
   and not in `PUBLISH_MANIFEST`. Decision needed: ship it or revert. If ship:
   add `dashboard/src/features-filter.ts` and `dashboard/features-filter.test.ts`
   to `PUBLISH_MANIFEST` and commit. Otherwise `git checkout -- dashboard/src/App.tsx`
   and remove the two new files so the submission tree is clean.
2. **Manifest drift.** ✅ Fixed: `src/crew/rollback.ts` and
   `src/crew/rollback.test.ts` added to `PUBLISH_MANIFEST`. Publish smoke now
   reaches the test/typecheck stage.
3. **No public remote.** `origin` is a private Gitea on the home LAN. The
   hackathon needs a public repo link: push a fresh GitHub repo from the
   manifest seed (`scripts/publish-public.sh`). Ensure the working tree is committed first.
4. **No LICENSE.** ✅ Fixed: MIT `LICENSE` added at repo root and registered
   in `PUBLISH_MANIFEST`.
5. **Filmed demo currently failing in this environment.**
   `bun run record-feature` times out waiting for retro (90s). The existing
   webm is from Oct 30 and may be acceptable, but a fresh recording is better.
   Either fix the retro timing or rely on the existing recording + VIDEO_SCRIPT.

### Recommended (non-blocking)

- Run leak-check for real: create `.leak-terms` with private hostnames/names
  and re-run `scripts/leak-check.sh` + `scripts/publish-public.sh /tmp/...`
  to prove the public seed builds and tests green.
- Keep `package.json` `private: true` (fine for GitHub; only blocks npm publish).
- Host the demo video (YouTube/Loom) and link it in the submission form; the
  repo itself is gitignored for `demo/recordings/`.
- Write a 2-3 sentence project pitch for the application: "A software factory
  that starts itself — clone, run the wizard, get a governed AI crew (Muse
  Wonder planner/red-team/retro, Muse Spark builder/QC) that takes a one-sentence
  work order and manufactures it overnight, with independent QC that can stop
  the line." Themes: Push the Frontier (autonomous software manufacturing) and
  Build for Your World (solo maintainer's side projects).
- Confirm eligibility: open worldwide except sanctioned regions; not a Meta
  employee/contractor.

### Not in main (do not ship half-finished)

- Per-model token cost feature exists only in worktrees (slot-3) and was
  REJECTed by red-team (pricing fetch hits HTML instead of markdown). Leave it
  out of the submission; main is clean of it.

### Bottom line

Engineering is done and green. The remaining ~30% is git hygiene (commit/revert
the filter feature, fix manifest), adding a LICENSE, mirroring to a public
GitHub repo, and producing/hosting the demo video. Realistic effort: 1-2 days,
within the Nov 4 deadline if started now.
