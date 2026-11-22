import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The live-proof script against a stub agent: same spawn path the
// dashboard uses, proving the scripted end-to-end (state -> approve ->
// dispatch -> done with a diff) without a real model call.
describe("live-proof script (stub agent)", () => {
  test("runs one task to done and prints the diff", async () => {
    const base = mkdtempSync(join(tmpdir(), "live-proof-test-"));
    const stub = join(base, "stub.ts");
    await Bun.write(
      stub,
      `const prompt = process.argv[process.argv.length - 1] ?? "";\n` +
        `const text = prompt.includes("Review the work") ? "qc: looks correct" : "built the feature";\n` +
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-1" }, payload_type: "run.terminal.completed", payload: { text } }));\n`,
    );
    const proc = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "live-proof.ts"),
      ],
      {
        env: {
          ...process.env,
          FACTORY_AGENT_COMMAND: `bun ${stub}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("final state: done");
    expect(stdout).toContain("builder (attempt");
    expect(stdout).toContain("sme:");
    expect(stdout).toContain("coder:");
    expect(stdout).toContain("git status");
  }, 60_000);
});
