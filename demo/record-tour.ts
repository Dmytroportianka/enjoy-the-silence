#!/usr/bin/env bun
// Guided-tour recording: boots the real pipeline against a mocked Muse and the
// real dashboard, then Playwright walks the control room through the Driver.js
// tour so the recording explains each part of the screen. Offline, deterministic.
//
//   bun demo/record-tour.ts                record to demo/recordings/control-room-tour.webm
//   bun demo/record-tour.ts --no-video     same run, no browser (CI-safe)
//   bun demo/record-tour.ts --keep         keep the temp run dir for inspection
import { execSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import {
  prepareFeatureRepo,
  runFeaturePipeline,
  STUB_COMMAND,
  submitFeatureTask,
} from "./feature-run";

const args = process.argv.slice(2);
const noVideo = args.includes("--no-video");
const keep = args.includes("--keep");
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? (args[outIndex + 1] ?? "") : "";
const factoryRoot = join(import.meta.dir, "..");
const port = 4322;
const baseUrl = `http://127.0.0.1:${port}`;

function ensureUiBuilt(): void {
  const dist = join(factoryRoot, "dashboard", "dist", "index.html");
  const srcDir = join(factoryRoot, "dashboard", "src");
  const newerThan = (dir: string, stamp: number): boolean =>
    readdirSync(dir, {
      withFileTypes: true,
    }).some((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return newerThan(path, stamp);
      return statSync(path).mtimeMs > stamp;
    });
  if (!existsSync(dist) || newerThan(srcDir, statSync(dist).mtimeMs)) {
    console.log("dashboard UI: rebuilding (source newer than dist)…");
    execSync("bun run build:ui", {
      cwd: factoryRoot,
      stdio: "inherit",
    });
  }
}

async function waitForDashboard(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    if (Date.now() > deadline) throw new Error("dashboard server did not come up in 15s");
    await Bun.sleep(250);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing recording-script complexity, split when next edited (see REVIEW.md)
async function main(): Promise<void> {
  ensureUiBuilt();
  const root = keep ? join(tmpdir(), "tour-recording") : mkdtempSync(join(tmpdir(), "tour-run-"));
  if (keep && existsSync(root))
    rmSync(root, {
      recursive: true,
      force: true,
    });
  const { store } = await prepareFeatureRepo(root);
  const taskId = "feature-1";
  const server = spawn(
    "bun",
    [
      "dashboard/server.ts",
    ],
    {
      cwd: factoryRoot,
      env: {
        ...process.env,
        FACTORY_DATA: join(root, "store"),
        DASHBOARD_PORT: String(port),
        DASHBOARD_DISPATCH: "off",
        DASHBOARD_AGENT_COMMAND: STUB_COMMAND.join(" "),
      },
      stdio: [
        "ignore",
        "ignore",
        "pipe",
      ],
    },
  );
  const started = Date.now();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    await waitForDashboard();
    // Seed a task so the floor and main panel have content during the tour.
    await submitFeatureTask(store, taskId);
    void runFeaturePipeline(store, taskId);
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
      await page.goto(`${baseUrl}/?tour=1`);
      await page.waitForTimeout(6_000);
      // Fallback: if the auto-start did not fire, click the Tour button.
      const tourBtn = page.getByRole("button", {
        name: "Tour",
      });
      if (await tourBtn.isVisible().catch(() => false)) {
        const popover = page.locator(".driver-popover");
        if (!(await popover.isVisible().catch(() => false))) await tourBtn.click().catch(() => {});
      }
      await page.waitForTimeout(2_000);
      // Walk through the Driver.js tour: click Next/Done as each popover appears.
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const next = page.locator(".driver-popover-next-btn, .driver-popover-done-btn").first();
        if (await next.isVisible().catch(() => false)) {
          await next.click().catch(() => {});
          await page.waitForTimeout(3000);
        } else {
          // tour finished or not yet started
          const popover = page.locator(".driver-popover");
          if (!(await popover.isVisible().catch(() => false))) break;
          await page.waitForTimeout(500);
        }
      }
      await page.waitForTimeout(6_000);
      await context.close();
      const recordings = readdirSync(join(root, "video")).filter((f) => f.endsWith(".webm"));
      if (recordings.length !== 1)
        throw new Error(`expected one recording, found ${recordings.length}`);
      const target = out || join(import.meta.dir, "recordings", "control-room-tour.webm");
      mkdirSync(dirname(target), {
        recursive: true,
      });
      copyFileSync(join(root, "video", recordings[0] ?? ""), target);
      console.log(`video: ${target}`);
    }
    console.log(`tour run: done in ${Math.round((Date.now() - started) / 1000)}s`);
    if (keep) console.log(`run dir kept: ${root}`);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    if (!keep)
      rmSync(root, {
        recursive: true,
        force: true,
      });
  }
}

await main().catch((error) => {
  console.error(`record-tour: ${(error as Error).message}`);
  process.exit(1);
});
