import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("walkthrough recording (no browser)", () => {
  test("runs the full pipeline end to end", () => {
    const result = spawnSync(
      "bun",
      [
        "demo/record-walkthrough.ts",
        "--no-video",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        encoding: "utf8",
        timeout: 300_000,
      },
    );
    if (result.status !== 0) {
      console.error(result.stdout);
      console.error(result.stderr);
    }
    expect(result.status).toBe(0);
  }, 300_000);

  test("recording script exists", () => {
    expect(existsSync(join(import.meta.dir, "record-walkthrough.ts"))).toBe(true);
  });
});
