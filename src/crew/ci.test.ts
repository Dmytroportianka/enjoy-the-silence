import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCi } from "./ci";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-test-"));
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), {
      recursive: true,
    });
    writeFileSync(full, text);
  }
  return dir;
}

describe("analyzeCi", () => {
  test("reads gitea workflows, derives verify from package scripts, flags checks CI never runs", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        scripts: {
          test: "bun test",
          typecheck: "bun x tsc --noEmit",
          dev: "bun run dev",
        },
      }),
      ".gitea/workflows/smoke.yml": [
        "name: incus-smoke",
        "on:",
        "  push:",
        "  pull_request:",
        "jobs:",
        "  incus-smoke:",
        "    runs-on: self-hosted",
        "    timeout-minutes: 20",
        "    steps:",
        "      - run: ./scripts/incus-smoke.sh",
        "",
      ].join("\n"),
    });
    const info = analyzeCi(dir);
    expect(info.workflows).toHaveLength(1);
    expect(info.workflows[0]?.name).toBe("incus-smoke");
    expect(info.workflows[0]?.triggers).toContain("push");
    expect(info.workflows[0]?.jobs).toContain("incus-smoke");
    expect(info.workflows[0]?.runs).toContain("./scripts/incus-smoke.sh");
    expect(info.workflows[0]?.heavy).toBe(true); // self-hosted + 20m + incus
    expect(info.suggestedVerify).toBe("bun run test && bun run typecheck");
    expect(info.notInCi).toEqual([
      "test",
      "typecheck",
    ]);
  });

  test("no CI folders: no workflows, verify still derived from scripts", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        scripts: {
          test: "bun test",
        },
      }),
    });
    const info = analyzeCi(dir);
    expect(info.workflows).toEqual([]);
    expect(info.suggestedVerify).toBe("bun run test");
    expect(info.notInCi).toEqual([
      "test",
    ]);
  });

  test("check named in a workflow is not flagged as missing from CI", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        scripts: {
          test: "bun test",
          lint: "eslint .",
        },
      }),
      ".github/workflows/ci.yml": [
        "name: ci",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: bun run test",
        "",
      ].join("\n"),
    });
    const info = analyzeCi(dir);
    expect(info.notInCi).toEqual([
      "lint",
    ]);
    expect(info.workflows[0]?.heavy).toBe(false);
  });
});
