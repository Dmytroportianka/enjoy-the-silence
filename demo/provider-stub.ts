// Quota-exhausted provider stub for the providers demo recording: the
// first builder call on this runner fails the way a real exhausted
// subscription fails (429 on stderr, non-zero exit — phrasing follows
// the real runs in factory-data: "usage limit … quota"), and every
// other call delegates to demo/pipeline-stub.ts unchanged. The factory
// classifies the failure as quota, marks this provider exhausted, and
// retries the builder station on the fallback provider, whose stub is
// pipeline-stub.ts itself. Offline and deterministic.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prompt = process.argv.at(-1) ?? "";
const role = /ROLE (\w+)/.exec(prompt)?.[1] ?? "";
const wt = /Worktree \(your only cwd\): (\S+)/.exec(prompt)?.[1] ?? process.cwd();
const marker = join(wt, ".quota-hit");

if (role === "builder" && !existsSync(marker)) {
  writeFileSync(marker, "1");
  console.error(
    "agy: 429 usage limit exceeded — this subscription's quota is exhausted (resets at the next billing window)",
  );
  process.exit(1);
}

const delegated = spawnSync(
  "bun",
  [
    join(import.meta.dir, "pipeline-stub.ts"),
    prompt,
  ],
  {
    cwd: process.cwd(),
    stdio: "inherit",
  },
);
process.exit(delegated.status ?? 1);
