import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseAgentPresets, parseCaddyRoutes, parseFleetBinaries } from "./parse";

export const ShowcaseDataSchema = z.object({
  generatedAt: z.string(),
  source: z.string(),
  routes: z.array(
    z.object({
      host: z.string(),
      path: z.string(),
      upstream: z.string(),
    }),
  ),
  presets: z.array(
    z.object({
      name: z.string(),
      command: z.string(),
      resume: z.string(),
      output: z.string(),
    }),
  ),
  fleet: z.array(z.string()),
  commits: z.array(
    z.object({
      hash: z.string(),
      date: z.string(),
      subject: z.string(),
    }),
  ),
});
export type ShowcaseData = z.infer<typeof ShowcaseDataSchema>;

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Live-read the reference repo. Returns null when the expected files are absent. */
export async function loadLiveData(repoRoot: string): Promise<ShowcaseData | null> {
  const [caddy, presets, status] = await Promise.all([
    readIfExists(join(repoRoot, "template/Caddyfile.example")),
    readIfExists(join(repoRoot, "src/crew/preset.ts")),
    readIfExists(join(repoRoot, "dashboard/server.ts")),
  ]);
  if (!caddy && !presets && !status) return null;
  let commits: ShowcaseData["commits"] = [];
  try {
    const out = execSync("git log --oneline -12 --date=short --format=%h%x09%ad%x09%s", {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
    });
    commits = out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash = "", date = "", ...rest] = line.split("\t");
        return {
          hash,
          date,
          subject: rest.join("\t"),
        };
      });
  } catch {
    commits = [];
  }
  return {
    generatedAt: new Date().toISOString(),
    source: `live read of ${repoRoot}`,
    routes: parseCaddyRoutes(caddy),
    presets: parseAgentPresets(presets),
    fleet: parseFleetBinaries(status),
    commits,
  };
}

/** Bundled snapshot fallback, validated at load. */
export async function loadSnapshot(snapshotPath: string): Promise<ShowcaseData> {
  const raw: unknown = JSON.parse(await readFile(snapshotPath, "utf8"));
  return ShowcaseDataSchema.parse(raw);
}

/** Live data when REPO_ROOT points at the reference repo, snapshot otherwise. */
export async function loadShowcaseData(baseDir: string): Promise<ShowcaseData> {
  const snapshotPath = join(baseDir, "data/snapshot.json");
  const repoRoot = process.env.REPO_ROOT;
  if (repoRoot) {
    const live = await loadLiveData(repoRoot).catch(() => null);
    if (live) {
      // A reference repo may not expose agent-preset definitions under the
      // generic path; fill that one section from the snapshot rather than
      // rendering it empty.
      if (live.presets.length === 0) {
        const snapshot = await loadSnapshot(snapshotPath).catch(() => null);
        if (snapshot) live.presets = snapshot.presets;
      }
      return live;
    }
  }
  return loadSnapshot(snapshotPath);
}
