import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// CI analysis: read a project's own CI folders (.gitea/workflows,
// .github/workflows, .gitlab-ci.yml) plus package scripts, so the
// factory can show what actually gates the repo and tasks can inherit
// a verify command derived from it instead of guessing one after a
// failed build. Cached on the mtimes of the files it reads.
export interface CiWorkflow {
  file: string;
  name: string;
  triggers: string[];
  jobs: string[];
  runs: string[];
  runsOn: string;
  heavy: boolean;
}
export interface CiInfo {
  workflows: CiWorkflow[];
  scripts: string[];
  suggestedVerify: string;
  notInCi: string[];
}

const ciCache = new Map<
  string,
  {
    key: string;
    info: CiInfo;
  }
>();

export function analyzeCi(repoPath: string): CiInfo {
  const files: {
    rel: string;
    full: string;
  }[] = [];
  for (const dir of [
    ".gitea/workflows",
    ".github/workflows",
  ]) {
    const full = join(repoPath, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full)
      .filter((n) => /\.ya?ml$/.test(n))
      .sort())
      files.push({
        rel: `${dir}/${name}`,
        full: join(full, name),
      });
  }
  if (existsSync(join(repoPath, ".gitlab-ci.yml")))
    files.push({
      rel: ".gitlab-ci.yml",
      full: join(repoPath, ".gitlab-ci.yml"),
    });
  const pkgPath = join(repoPath, "package.json");
  const key = [
    ...files.map((f) => `${f.rel}:${statSync(f.full).mtimeMs}`),
    existsSync(pkgPath) ? `pkg:${statSync(pkgPath).mtimeMs}` : "pkg:-",
  ].join("|");
  const hit = ciCache.get(repoPath);
  if (hit && hit.key === key) return hit.info;
  const workflows: CiWorkflow[] = files.map(({ rel, full }) => {
    const text = readFileSync(full, "utf8");
    const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? rel;
    const triggers = [
      "push",
      "pull_request",
      "workflow_dispatch",
      "schedule",
    ].filter((t) => new RegExp(`(^|\\s)${t}[:\\s]`).test(text));
    const jobsSection = text.split(/^jobs:/m)[1] ?? "";
    const jobs = [
      ...jobsSection.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm),
    ]
      .map((m) => m[1] ?? "")
      .filter(Boolean);
    const runs = [
      ...text.matchAll(/^\s*-?\s*run:\s*(.+)$/gm),
    ]
      .map((m) => (m[1] ?? "").trim())
      .filter(Boolean);
    const runsOn = /runs-on:\s*(.+)/.exec(text)?.[1]?.trim() ?? "";
    const timeout = Number(/timeout-minutes:\s*(\d+)/.exec(text)?.[1] ?? 0);
    const heavy =
      runsOn.includes("self-hosted") || timeout >= 15 || /incus|docker|vagrant/i.test(text);
    return {
      file: rel,
      name,
      triggers,
      jobs,
      runs,
      runsOn,
      heavy,
    };
  });
  let scripts: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    scripts = Object.keys(pkg.scripts ?? {});
  } catch {
    /* no package.json: scripts stay empty */
  }
  const ciText = files.map((f) => readFileSync(f.full, "utf8")).join("\n");
  const checkScripts = [
    "test",
    "typecheck",
    "lint",
  ].filter((s) => scripts.includes(s));
  const suggestedVerify = checkScripts.map((s) => `bun run ${s}`).join(" && ");
  const notInCi = checkScripts.filter((s) => !ciText.includes(s));
  const info: CiInfo = {
    workflows,
    scripts,
    suggestedVerify,
    notInCi,
  };
  ciCache.set(repoPath, {
    key,
    info,
  });
  return info;
}
