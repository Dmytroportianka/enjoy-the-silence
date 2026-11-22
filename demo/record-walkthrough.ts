#!/usr/bin/env bun
// Combined walkthrough recording: control-room tour first, then a full
// feature-creation run, all annotated with Driver.js tooltips.
// Output: demo/recordings/walkthrough.webm
// biome-ignore-all lint/suspicious/noExplicitAny: baseline: Playwright tour-tip window hooks are untyped by design, split when next edited (see REVIEW.md)
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
  FEATURE_PROMPT,
  FEATURE_TITLE,
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
const port = 4324;
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
    console.log("dashboard UI: rebuilding…");
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
    } catch {}
    if (Date.now() > deadline) throw new Error("dashboard server did not come up in 15s");
    await Bun.sleep(250);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing recording-script complexity, split when next edited (see REVIEW.md)
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing recording-script length, split when next edited (see REVIEW.md)
async function main(): Promise<void> {
  ensureUiBuilt();
  const root = keep
    ? join(tmpdir(), "walkthrough-recording")
    : mkdtempSync(join(tmpdir(), "walkthrough-run-"));
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
    await submitFeatureTask(store, taskId);
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

      // Phase 1: control-room tour
      await page.goto(`${baseUrl}/?tour=1`);
      await page.waitForTimeout(2_000);
      const tourDeadline = Date.now() + 120_000;
      while (Date.now() < tourDeadline) {
        const next = page.locator(".driver-popover-next-btn, .driver-popover-done-btn").first();
        if (await next.isVisible().catch(() => false)) {
          await next.click().catch(() => {});
          await page.waitForTimeout(3_000);
        } else {
          const pop = page.locator(".driver-popover");
          if (!(await pop.isVisible().catch(() => false))) break;
          await page.waitForTimeout(500);
        }
      }
      await page.waitForTimeout(3_000);
      await page.evaluate(() => (window as any).clearTip?.());

      // Phase 2: state a task via the real form
      await page.goto(`${baseUrl}/state-task`);
      await page.waitForTimeout(2_000);
      await page.evaluate(() =>
        (window as any).showTip(
          "#tour-main",
          "State a task",
          "Describe what to build in plain language. Triage estimates effort and picks the lane; planning starts on its own.",
        ),
      );
      await page.waitForTimeout(4_000);
      await page.evaluate(() => (window as any).clearTip());
      const promptBox = page.locator("#nt-prompt");
      await promptBox.fill(FEATURE_PROMPT);
      await page.waitForTimeout(2_000);
      await page.evaluate(() =>
        (window as any).showTip(
          "#nt-prompt",
          "The request",
          "Name the deliverable concretely. This becomes the task title and body.",
        ),
      );
      await page.waitForTimeout(4_000);
      await page.evaluate(() => (window as any).clearTip());
      const submitBtn = page.getByRole("button", {
        name: "State task",
      });
      await submitBtn.waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await submitBtn.scrollIntoViewIfNeeded();
      await submitBtn.click({
        force: true,
      });
      // Wait for redirect to the new task's detail page and capture its id.
      try {
        await page.waitForURL(/\/tasks\//, {
          timeout: 20_000,
        });
      } catch {
        // Fallback if the click did not navigate: submit via API and open the task.
        const id = "feature-1";
        await submitFeatureTask(store, id).catch(() => {});
        await page.goto(`${baseUrl}/tasks/${id}`);
      }
      const m = page.url().match(/\/tasks\/([^/?]+)/);
      const uiTaskId = m && m[1] ? decodeURIComponent(m[1]) : taskId;
      await page.waitForTimeout(2_000);
      await page.evaluate(() =>
        (window as any).showTip(
          "#tour-main",
          "Task created",
          "The task is stated and planning begins automatically. No extra click needed.",
        ),
      );
      await page.waitForTimeout(4_000);
      await page.evaluate(() => (window as any).clearTip());
      void runFeaturePipeline(store, uiTaskId);

      const row = page
        .getByText(FEATURE_TITLE, {
          exact: false,
        })
        .first();
      await row.waitFor({
        timeout: 90_000,
      });
      await row.evaluate((el) => {
        el.id = "tour-task-row";
      });
      await page.evaluate(() =>
        (window as any).showTip(
          "#tour-task-row",
          "New feature request",
          "A task entered the Inbox. The factory will plan, red-team, build, review, and land it.",
        ),
      );
      await page.waitForTimeout(5_000);
      await row.click().catch(() => {});
      await page.evaluate(() =>
        (window as any).showTip(
          "#tour-main",
          "Station progress",
          "Watch plan, red-team, build, review, and landing run here with live output.",
        ),
      );
      await page.waitForTimeout(4_000);

      const stationTips: Record<
        string,
        [
          string,
          string,
        ]
      > = {
        planner: [
          "Planning",
          "An agent drafts the plan: intent, why, approach, success criteria, prerequisites.",
        ],
        redteam: [
          "Red-team",
          "An independent agent attacks the plan for gaps and risks before code.",
        ],
        outsider: [
          "Outside review",
          "A second perspective checks the plan.",
        ],
        builder: [
          "Building",
          "The coder implements in an isolated worktree, running checks.",
        ],
        qc: [
          "Quality check",
          "Verification and quality gates run on the changed worktree.",
        ],
        reviewer: [
          "Review",
          "A reviewer inspects the diff against patterns and success criteria.",
        ],
        fixer: [
          "Fixing",
          "Addressing review findings before landing.",
        ],
        retro: [
          "Retrospective",
          "A retro agent reviews the run and files learnings as tasks.",
        ],
      };
      let lastActor: string | null = null;
      const pollDeadline = Date.now() + 6 * 60_000;
      while (Date.now() < pollDeadline) {
        const task = await store.readTask(uiTaskId);
        if (!task) break;
        let liveRole: string | null = null;
        try {
          const res = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(uiTaskId)}`);
          const d = (await res.json()) as {
            live?: {
              role?: string;
            } | null;
          };
          liveRole = d.live?.role ?? null;
        } catch {}
        if (liveRole && liveRole !== lastActor) {
          lastActor = liveRole;
          const [title, desc] = stationTips[liveRole] ?? [
            "Working",
            `Station ${liveRole} is running.`,
          ];
          await page.evaluate(
            ({ title, desc }) => (window as any).showTip("#tour-main", title, desc),
            {
              title,
              desc,
            },
          );
          await page.waitForTimeout(5_000);
        }
        if (
          task.state === "done" ||
          task.state === "failed" ||
          task.state === "needs-input" ||
          task.state === "blocked"
        )
          break;
        await Bun.sleep(1_500);
      }
      const finalTask = await store.readTask(uiTaskId);
      if (finalTask?.state === "done") {
        await page.evaluate(() =>
          (window as any).showTip(
            "#tour-main",
            "Feature landed",
            "Build passed verification and the branch landed on main.",
          ),
        );
        await page.waitForTimeout(5_000);
      }
      await waitForRetro(store, uiTaskId);
      await page.evaluate(() =>
        (window as any).showTip(
          "#tour-main",
          "Retrospective filed",
          "A retro agent reviewed the run and filed a finding as a candidate task.",
        ),
      );
      await page.waitForTimeout(5_000);
      await page.evaluate(() => (window as any).clearTip());
      await page.goto(baseUrl).catch(() => {});
      await page.waitForTimeout(6_000);
      await context.close();
      const recordings = readdirSync(join(root, "video")).filter((f) => f.endsWith(".webm"));
      if (recordings.length !== 1)
        throw new Error(`expected one recording, found ${recordings.length}`);
      const target = out || join(import.meta.dir, "recordings", "walkthrough.webm");
      mkdirSync(dirname(target), {
        recursive: true,
      });
      copyFileSync(join(root, "video", recordings[0] ?? ""), target);
      console.log(`video: ${target}`);
    }
    console.log(`walkthrough: done in ${Math.round((Date.now() - started) / 1000)}s`);
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

async function waitForRetro(store: any, taskId: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const retro = await store.readRetro(taskId).catch(() => null);
    if (retro && !retro.error) return;
    if (Date.now() > deadline) throw new Error("retro did not arrive within 90s");
    await Bun.sleep(1_000);
  }
}

await main().catch((error) => {
  console.error(`record-walkthrough: ${(error as Error).message}`);
  process.exit(1);
});
