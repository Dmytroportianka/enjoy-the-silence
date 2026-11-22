#!/usr/bin/env bun
// Feature-creation recording: boots the real pipeline against a mocked Muse
// (demo/pipeline-stub.ts) and the real dashboard against the same store, then
// Playwright records the control room watching the work run plan -> red-team
// -> build -> review bounce -> land -> done. Offline, deterministic, no keys.
//
//   bun demo/record-feature.ts                record to demo/recordings/feature-creation.webm
//   bun demo/record-feature.ts --no-video     same run, no browser (CI-safe)
//   bun demo/record-feature.ts --keep         keep the temp run dir for inspection
//   bun demo/record-feature.ts --out x.webm   record to a chosen path
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
const port = 4321;
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

async function waitForDone(
  store: Awaited<ReturnType<typeof prepareFeatureRepo>>["store"],
  taskId: string,
) {
  const deadline = Date.now() + 6 * 60_000;
  for (;;) {
    const task = await store.readTask(taskId);
    if (task?.state === "done") return;
    if (task?.state === "failed") throw new Error(`feature run: task ${taskId} failed`);
    if (task?.state === "needs-input")
      throw new Error(`feature run: task ${taskId} parked on owner input`);
    if (Date.now() > deadline)
      throw new Error(`feature run: task ${taskId} did not finish in 6 min`);
    await Bun.sleep(500);
  }
}

async function waitForRetro(
  store: Awaited<ReturnType<typeof prepareFeatureRepo>>["store"],
  taskId: string,
): Promise<void> {
  // The dashboard's sweep runs the retro ~30s after the task lands (it waits
  // for the pipeline's final records to settle). The stub answers it, so the
  // recording ends with the retrospective and its filed finding on screen.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const retro = await store.readRetro(taskId).catch(() => null);
    if (retro && !retro.error) return;
    if (Date.now() > deadline)
      throw new Error("retro did not arrive within 90s of the task finishing");
    await Bun.sleep(1_000);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing recording-script complexity, split when next edited (see REVIEW.md)
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing recording-script length, split when next edited (see REVIEW.md)
async function main(): Promise<void> {
  ensureUiBuilt();
  const root = keep
    ? join(tmpdir(), "feature-recording")
    : mkdtempSync(join(tmpdir(), "feature-run-"));
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
        // The harness drives the pipeline itself; the dashboard is a pure
        // viewer here and must never dispatch with the real muse command.
        DASHBOARD_DISPATCH: "off",
        // The dashboard's own sweeps (retro included) must also speak to
        // the stub, never to a real muse session.
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
  let pipeline: Promise<unknown> | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    await waitForDashboard();
    if (!noVideo) {
      browser = await chromium.launch();
      const context = await browser.newContext({
        viewport: {
          width: 1920,
          height: 1080,
        },
        deviceScaleFactor: 1,
        recordVideo: {
          dir: join(root, "video"),
          size: {
            width: 1920,
            height: 1080,
          },
        },
      });
      const page = await context.newPage();
      await page.goto(baseUrl);
      await page.waitForTimeout(1_500);
      await page.evaluate(() =>
        (window as any).showTip(
          "#tour-main",
          "Control room",
          "This is the Agent Factory control room. We are about to submit a feature request and watch it run.",
        ),
      );
      await page.waitForTimeout(4_000);
      await page.evaluate(() => (window as any).clearTip());
      // Submit once the floor is watching, so the row appears live.
      await submitFeatureTask(store, taskId);
      pipeline = runFeaturePipeline(store, taskId);
      // Open the task card and let the recording capture the run. The floor
      // and the task page both update over SSE; the harness polls the store
      // for the verdict, which is the same state the UI renders.
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
          "A task just entered the Inbox. The factory will plan, red-team, build, review, and land it.",
        ),
      );
      await page.waitForTimeout(5_000);
      await row.click().catch(() => {});
      await page.evaluate(() =>
        (window as any).showTip(
          "#tour-main",
          "Station progress",
          "Watch the plan, red-team, build, review, and landing steps run here. Live agent output streams in.",
        ),
      );
      await page.waitForTimeout(4_000);
      // Walk through every station as it runs, annotating the screen with a
      // detailed explanation of what that station is doing.
      const stationTips: Record<
        string,
        [
          string,
          string,
        ]
      > = {
        planner: [
          "Planning",
          "An agent drafts the implementation plan: intent, why, approach, success criteria, and prerequisites.",
        ],
        redteam: [
          "Red-team",
          "An independent agent attacks the plan for gaps, risks, and missing edge cases before any code is written.",
        ],
        outsider: [
          "Outside review",
          "An outsider agent reviews the plan from a fresh perspective, separate from the planner.",
        ],
        builder: [
          "Building",
          "The coder implements the plan in an isolated worktree, running checks as it goes.",
        ],
        qc: [
          "Quality check",
          "Verification and quality gates run against the changed worktree.",
        ],
        reviewer: [
          "Review",
          "A reviewer inspects the diff against patterns and success criteria.",
        ],
        fixer: [
          "Fixing",
          "Addressing findings from review before the branch can land.",
        ],
        retro: [
          "Retrospective",
          "A retro agent reviews the whole run and files learnings as new tasks.",
        ],
      };
      let lastActor: string | null = null;
      const pollDeadline = Date.now() + 6 * 60_000;
      while (Date.now() < pollDeadline) {
        const task = await store.readTask(taskId);
        if (!task) break;
        let liveRole: string | null = null;
        try {
          const res = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`);
          const d = (await res.json()) as {
            live?: {
              role?: string;
            } | null;
          };
          liveRole = d.live?.role ?? null;
        } catch {
          /* ignore */
        }
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
      const finalTask = await store.readTask(taskId);
      if (finalTask?.state === "done") {
        await page.evaluate(() =>
          (window as any).showTip(
            "#tour-main",
            "Feature landed",
            "The build passed verification and the branch landed on main. The task moves to done.",
          ),
        );
        await page.waitForTimeout(5_000);
      }
      // The dashboard sweep files the retro ~30s after landing; stay on the
      // task page so the recording catches the retro station arrive, then
      // cut to the floor for the finished state.
      await waitForRetro(store, taskId);
      await page.evaluate(() =>
        (window as any).showTip(
          "#tour-main",
          "Retrospective filed",
          "A retro agent reviewed the run and filed a finding as a new candidate task.",
        ),
      );
      await page.waitForTimeout(5_000);
      await page.evaluate(() => (window as any).clearTip());
      await page.goto(baseUrl).catch(() => {});
      await page.waitForTimeout(5_000);
      await context.close();
      const recordings = readdirSync(join(root, "video")).filter((f) => f.endsWith(".webm"));
      if (recordings.length !== 1)
        throw new Error(`expected one recording, found ${recordings.length}`);
      const target = out || join(import.meta.dir, "recordings", "feature-creation.webm");
      mkdirSync(dirname(target), {
        recursive: true,
      });
      // Copy, never rename: the temp run dir may live on another filesystem
      // than the output path (/tmp vs the repo), and rename cannot cross
      // devices.
      copyFileSync(join(root, "video", recordings[0] ?? ""), target);
      console.log(`video: ${target}`);
    } else {
      await submitFeatureTask(store, taskId);
      pipeline = runFeaturePipeline(store, taskId);
      await waitForDone(store, taskId);
      await waitForRetro(store, taskId);
    }
    if (pipeline) await pipeline;
    console.log(`feature run: done in ${Math.round((Date.now() - started) / 1000)}s`);
    console.log(`task states on the floor: ${baseUrl} (FACTORY_DATA=${join(root, "store")})`);
    if (keep) console.log(`run dir kept: ${root}`);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    if (!keep) {
      rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }
}

await main().catch((error) => {
  console.error(`record-feature: ${(error as Error).message}`);
  console.error(`feature run: prompt was "${FEATURE_PROMPT}"`);
  process.exit(1);
});
