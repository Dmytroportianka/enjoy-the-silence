#!/usr/bin/env bun
// Wizard walkthrough recording: a standalone terminal window runs the wizard
// end to end, annotated with Driver.js tooltips.
// Output: demo/recordings/wizard.webm
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const noVideo = args.includes("--no-video");
const keep = args.includes("--keep");
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? (args[outIndex + 1] ?? "") : "";
const factoryRoot = join(import.meta.dir, "..");
const htmlPath = join(factoryRoot, "demo", "wizard-terminal.html");
const fileUrl = `file://${htmlPath}`;

const args2 = process.argv.slice(2);
void args2;

async function main(): Promise<void> {
  const root = keep
    ? join(tmpdir(), "wizard-recording")
    : mkdtempSync(join(tmpdir(), "wizard-run-"));
  if (keep && existsSync(root))
    rmSync(root, {
      recursive: true,
      force: true,
    });
  mkdirSync(join(root, "video"), {
    recursive: true,
  });
  const started = Date.now();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    if (!noVideo) {
      browser = await chromium.launch();
      const context = await browser.newContext({
        viewport: {
          width: 1920,
          height: 1080,
        },
        recordVideo: {
          dir: join(root, "video"),
          size: {
            width: 1920,
            height: 1080,
          },
        },
      });
      const page = await context.newPage();
      await page.goto(fileUrl);
      // Let the scripted terminal + tooltips play out (~18s), then hold.
      await page.waitForTimeout(20_000);
      await context.close();
      const recordings = readdirSync(join(root, "video")).filter((f) => f.endsWith(".webm"));
      if (recordings.length !== 1)
        throw new Error(`expected one recording, found ${recordings.length}`);
      const target = out || join(import.meta.dir, "recordings", "wizard.webm");
      mkdirSync(dirname(target), {
        recursive: true,
      });
      copyFileSync(join(root, "video", recordings[0] ?? ""), target);
      console.log(`video: ${target}`);
    }
    console.log(`wizard run: done in ${Math.round((Date.now() - started) / 1000)}s`);
    if (keep) console.log(`run dir kept: ${root}`);
  } finally {
    await browser?.close().catch(() => {});
    if (!keep)
      rmSync(root, {
        recursive: true,
        force: true,
      });
  }
}

await main().catch((error) => {
  console.error(`record-wizard: ${(error as Error).message}`);
  process.exit(1);
});
