import { expect, test } from "bun:test";
import { join } from "node:path";

// The offline rehearsal is the demo's hero scene: builder plants a fault,
// QC stops the line, fixer reworks, QC passes. Run it end to end so a
// broken gate fails here instead of on camera.
test("offline demo: QC catches the planted fault, fixer fixes it, QC passes", async () => {
  const proc = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "run-demo.ts"),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  expect(out).toContain("QC FAIL: missing semicolon after listen 8080");
  expect(out).toContain("QC stopped the line. Dispatching fixer");
  expect(out).toContain("Run report: hello service built, planted fault caught by QC");
}, 30_000);
