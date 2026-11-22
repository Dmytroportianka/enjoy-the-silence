// Regenerate data/snapshot.json from a reference repo checkout.
// Usage: REPO_ROOT=/path/to/nixos-config bun run snapshot
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadLiveData, loadSnapshot } from "../src/data";

const repoRoot = process.env.REPO_ROOT;
if (!repoRoot) {
  console.error("REPO_ROOT is required, e.g. REPO_ROOT=~/nixos-config bun run snapshot");
  process.exit(1);
}
const data = await loadLiveData(repoRoot);
if (!data) {
  console.error(`No reference files found under ${repoRoot}`);
  process.exit(1);
}
if (data.presets.length === 0) {
  // Reference repo does not expose presets under the generic path; keep the
  // existing snapshot's preset evidence rather than blanking the section.
  try {
    const existing = await loadSnapshot(join(import.meta.dir, "../data/snapshot.json"));
    if (existing.presets.length) data.presets = existing.presets;
  } catch {
    // No prior snapshot; leave presets empty.
  }
}
const snapshot = {
  ...data,
  source:
    "bundled snapshot of the reference homelab repo (live reads take precedence when REPO_ROOT is set)",
};
const out = join(import.meta.dir, "../data/snapshot.json");
await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(
  `wrote ${out}: ${snapshot.routes.length} routes, ${snapshot.presets.length} presets, ` +
    `${snapshot.fleet.length} fleet, ${snapshot.commits.length} commits`,
);
