#!/usr/bin/env bun
// Providers demo recordings — three SHORT clips, one key feature each,
// instead of one long video. Playwright records the real dashboard with
// intro tooltips; every model call is mocked (demo/pipeline-stub.ts +
// demo/provider-stub.ts), so no tokens are spent and each clip is
// deterministic. Station behaviour mirrors the real runs in factory-data.
//
//   bun demo/record-providers.ts                  record all three clips
//   bun demo/record-providers.ts --scene models   record one clip
//   bun demo/record-providers.ts --no-video       same runs, no browser (CI-safe)
//   bun demo/record-providers.ts --keep           keep the temp run dir
//
// Scenes: create (state a task -> factory lands it), models (switch a
// model presets in Settings), failover (the
// builder's agy quota is exhausted -> muse backup finishes the feature).
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
import { chromium, type Page } from "playwright";
import {
  prepareFeatureRepo,
  runFeaturePipeline,
  SHOWCASE_PROMPT,
  SHOWCASE_TITLE,
  STUB_COMMAND,
  submitFeatureTask,
} from "./feature-run";
import {
  FAILOVER_PROMPT,
  FAILOVER_TITLE,
  runFailoverFeature,
  submitFailoverTask,
} from "./providers-run";

const args = process.argv.slice(2);
const noVideo = args.includes("--no-video");
const keep = args.includes("--keep");
const sceneArg = args[args.indexOf("--scene") + 1] ?? "all";
const outIndex = args.indexOf("--out");
const outOverride = outIndex >= 0 ? (args[outIndex + 1] ?? "") : "";
const SCENES = [
  "create",
  "models",
  "failover",
] as const;
type Scene = (typeof SCENES)[number];
const scenes: Scene[] =
  sceneArg === "all"
    ? [
        ...SCENES,
      ]
    : [
        sceneArg as Scene,
      ];
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
      return entry.isDirectory() ? newerThan(path, stamp) : statSync(path).mtimeMs > stamp;
    });
  if (!existsSync(dist) || newerThan(srcDir, statSync(dist).mtimeMs)) {
    console.log("dashboard UI: rebuilding (source newer than dist)…");
    execSync("bun run build:ui", {
      cwd: factoryRoot,
      stdio: "inherit",
    });
  }
}

// Localhost must bypass any proxy from the owner's shell, in this
// process (Bun fetch) and in Chromium (its API calls) alike.
process.env.NO_PROXY = [
  process.env.NO_PROXY,
  "127.0.0.1",
  "localhost",
]
  .filter(Boolean)
  .join(",");
process.env.no_proxy = process.env.NO_PROXY;
const browserEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(http|https)_proxy$/i.test(k)) env[k] = v;
  }
  return env;
};

async function waitForDashboard(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dashboard server did not come up in 15s");
    await Bun.sleep(250);
  }
}

type Store = Awaited<ReturnType<typeof prepareFeatureRepo>>["store"];
async function waitForDone(store: Store, taskId: string): Promise<void> {
  const deadline = Date.now() + 6 * 60_000;
  for (;;) {
    const task = await store.readTask(taskId);
    if (task?.state === "done") return;
    if (task?.state === "failed" || task?.state === "blocked")
      throw new Error(`providers run: task ${taskId} ended ${task.state}`);
    if (Date.now() > deadline)
      throw new Error(`providers run: task ${taskId} did not finish in 6 min`);
    await Bun.sleep(500);
  }
}

async function tip(
  page: Page,
  testId: string,
  title: string,
  description: string,
  holdMs = 5_000,
): Promise<void> {
  const selector = `[data-testid="${testId}"]`;
  await page.evaluate(
    ({ selector, title, description }) => (window as any).showTip(selector, title, description),
    {
      selector,
      title,
      description,
    },
  );
  await page.waitForTimeout(holdMs);
  await page.evaluate(() => (window as any).clearTip());
  await page.waitForTimeout(500); // driver overlay teardown before the next click
}

async function stateTaskViaUi(
  page: Page,
  prompt: string,
  intro: [
    string,
    string,
  ],
): Promise<void> {
  await page.getByTestId("nav-state").click();
  await page.getByTestId("nt-prompt").waitFor({
    timeout: 90_000,
  });
  await tip(page, "nt-prompt", intro[0], intro[1], 4_500);
  await page.getByTestId("nt-prompt").fill(prompt);
  await page.waitForTimeout(1_200);
  await page.getByTestId("state-task-submit").click();
  await page.waitForTimeout(1_500);
}

async function clickWithRetry(page: Page, testId: string): Promise<void> {
  const loc = page.getByTestId(testId);
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc
    .click({
      timeout: 20_000,
    })
    .catch(async () => {
      await page.waitForTimeout(1_200);
      await loc.click({
        timeout: 30_000,
      });
    });
}

async function taskIdByPrompt(store: Store, prompt: string): Promise<string> {
  const task = (await store.listTasks()).find((t) => t.prompt === prompt);
  if (!task) throw new Error("UI-stated task not found in store");
  return task.id;
}

async function sceneCreate(page: Page, store: Store): Promise<void> {
  await tip(
    page,
    "main",
    "Create a feature",
    "One sentence becomes a multi-file feature: a status page at /status with JSON + HTML, tests, and a declared screenshot moment. Model calls are mocked; planning, red-teaming, building, review, visual approval and landing are the real factory.",
    6_500,
  );
  await stateTaskViaUi(page, SHOWCASE_PROMPT, [
    "One sentence in",
    "Triage estimates the work, a planner drafts the plan — including the Visual moments the owner will later approve as screenshots — and two red-teams attack it.",
  ]);
  // The demo app is served by its own server.js; pointing the project at
  // it lets Visual Review screenshot /status on base and feature.
  const project = await store.readProject("demo");
  if (project)
    await store.writeProject({
      ...project,
      devCommand: "node server.js",
      devPort: 4391,
    });
  const run = (async () =>
    runFeaturePipeline(store, await taskIdByPrompt(store, SHOWCASE_PROMPT)).catch(() => {}))();
  const row = page
    .getByText(SHOWCASE_TITLE, {
      exact: false,
    })
    .first();
  await row.waitFor({
    timeout: 90_000,
  });
  await tip(
    page,
    "main",
    "The factory manufactures it",
    "Planner → red-teams → builder → dual review → verify → Visual Review → land. Watch the stations and the diff grow — several files this time, not a toy route.",
    5_500,
  );
  await row.click().catch(() => {});
  // Visual Review parks the task before landing: approve it on camera.
  const taskId = await taskIdByPrompt(store, SHOWCASE_PROMPT);
  let approved = false;
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const task = await store.readTask(taskId);
    if (task?.state === "done") break;
    if (!approved && task?.state === "needs-input" && task?.visualState === "pending") {
      approved = true;
      await page
        .getByRole("button", {
          name: "Approve & land",
        })
        .waitFor({
          timeout: 30_000,
        })
        .catch(() => {});
      await tip(
        page,
        "main",
        "Visual Review: your eyes before it lands",
        "The new /status page, screenshot-diffed against the base commit (Before / After / Diff). Nothing lands until the owner approves — that click is real, against the dashboard API.",
        6_500,
      );
      await page
        .getByRole("button", {
          name: "Approve & land",
        })
        .click();
      await page.waitForTimeout(2_000);
    }
    await Bun.sleep(1_000);
  }
  await run;
  await waitForDone(store, taskId);
  await page.waitForTimeout(2_000);
  await tip(
    page,
    "main",
    "Feature landed",
    "Multi-file feature, verified, visually approved, landed on main. Next clip: change who does the building.",
    5_500,
  );
}

async function sceneModels(page: Page): Promise<void> {
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("presets-list").waitFor({
    timeout: 90_000,
  });
  await tip(
    page,
    "presets-list",
    "Presets: whole routing sets, one per subscription",
    "A preset says which runner, model and effort every station uses. Keep as many as you like — when the active preset's quota runs out, the factory swaps to the next preset in this order.",
    6_500,
  );
  await clickWithRetry(page, "preset-suggested-preset-agy-builds");
  await page.waitForTimeout(800);
  await page.getByTestId("preset-critical-failure-preset-agy-builds").fill("50");
  await tip(
    page,
    "presets-list",
    "Suggested from your installed agents",
    "With muse and agy installed, the factory suggests cross-family presets: Gemini builds the code, Muse checks it — a different subscription grades the work, never the same line.",
    6_500,
  );
  await clickWithRetry(page, "preset-activate-preset-agy-builds");
  await page.getByTestId("route-provider-builder").scrollIntoViewIfNeeded();
  await tip(
    page,
    "route-provider-builder",
    "Gemini builds, Muse checks",
    "In this preset the builder runs gemini-3-flash on the Antigravity subscription, while the planner, red-teams and reviewers stay on muse. Execution is cheap; judgment stays independent.",
    6_000,
  );
  await clickWithRetry(page, "preset-save");
  await page.waitForTimeout(1_800);
}

async function sceneFailover(page: Page, store: Store): Promise<void> {
  await tip(
    page,
    "main",
    "Quota failover",
    "Settings already moved the builder to agy with a muse backup. This feature spends the agy quota mid-build — watch the factory recover on its own.",
    6_000,
  );
  await stateTaskViaUi(page, FAILOVER_PROMPT, [
    "A second feature",
    "Same one-sentence flow. The builder starts on agy — whose subscription quota is exhausted.",
  ]);
  const run = (async () =>
    runFailoverFeature(store, await taskIdByPrompt(store, FAILOVER_PROMPT)).catch(() => {}))();
  const row = page
    .getByText(FAILOVER_TITLE, {
      exact: false,
    })
    .first();
  await row.waitFor({
    timeout: 90_000,
  });
  await tip(
    page,
    "main",
    "Building on agy…",
    "The builder's first call goes to the Antigravity subscription. Its quota is gone: a real 429, not a code failure.",
    5_500,
  );
  await row.click().catch(() => {});
  const taskId = await taskIdByPrompt(store, FAILOVER_PROMPT);
  await waitForDone(store, taskId);
  await run;
  const builder = (await store.listDeliveries(taskId)).find((d) => d.stationId === "builder");
  if (!builder?.detail.includes("quota exhausted on agy"))
    throw new Error("failover did not happen on camera");
  await page.reload();
  await page.waitForTimeout(2_500);
  await tip(
    page,
    "main",
    "Failover: quota spent, work landed",
    "agy answered 429 — quota exhausted. The factory marked that provider exhausted until its reset, retried the builder on the muse backup with a fresh session, and the feature landed. Station history records which provider did the work.",
    7_000,
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing recording-script complexity, split when next edited (see REVIEW.md)
async function main(): Promise<void> {
  ensureUiBuilt();
  const root = keep
    ? join(tmpdir(), "providers-recording")
    : mkdtempSync(join(tmpdir(), "providers-run-"));
  if (keep && existsSync(root))
    rmSync(root, {
      recursive: true,
      force: true,
    });
  const { store } = await prepareFeatureRepo(root);
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
    if (noVideo) {
      if (scenes.includes("create")) {
        await submitFeatureTask(store, "feature-1");
        await runFeaturePipeline(store, "feature-1");
        await waitForDone(store, "feature-1");
      }
      if (scenes.includes("failover")) {
        await submitFailoverTask(store, "feature-2");
        const second = await runFailoverFeature(store, "feature-2");
        if (second.state !== "done")
          throw new Error(`providers run: failover feature ended ${second.state}`);
      }
      console.log(`providers run (no video): scenes ${scenes.join(", ")} landed`);
    } else {
      browser = await chromium.launch({
        env: browserEnv(),
      });
      const targets: Record<Scene, string> = {
        create: "create-feature.webm",
        models: "switch-models.webm",
        failover: "quota-failover.webm",
      };
      for (const scene of scenes) {
        const context = await browser.newContext({
          viewport: {
            width: 1920,
            height: 1080,
          },
          deviceScaleFactor: 1,
          recordVideo: {
            dir: join(root, `video-${scene}`),
            size: {
              width: 1920,
              height: 1080,
            },
          },
        });
        const page = await context.newPage();
        page.setDefaultTimeout(60_000);
        await page.goto(baseUrl);
        await page.waitForTimeout(1_200);
        try {
          if (scene === "create") await sceneCreate(page, store);
          else if (scene === "models") await sceneModels(page);
          else await sceneFailover(page, store);
        } catch (err) {
          await page
            .screenshot({
              path: `/tmp/record-fail-${scene}.png`,
            })
            .catch(() => {});
          console.error(
            `scene ${scene} failed; screenshot /tmp/record-fail-${scene}.png; page text: ${(
              await page
                .locator("body")
                .innerText()
                .catch(() => "")
            ).slice(0, 300)}`,
          );
          throw err;
        }
        await context.close();
        const recordings = readdirSync(join(root, `video-${scene}`)).filter((f) =>
          f.endsWith(".webm"),
        );
        if (recordings.length !== 1)
          throw new Error(`scene ${scene}: expected one recording, found ${recordings.length}`);
        const target =
          outOverride && scenes.length === 1
            ? outOverride
            : join(import.meta.dir, "recordings", targets[scene]);
        mkdirSync(dirname(target), {
          recursive: true,
        });
        copyFileSync(join(root, `video-${scene}`, recordings[0] ?? ""), target);
        console.log(`video: ${target}`);
      }
    }
    console.log(`providers run: done in ${Math.round((Date.now() - started) / 1000)}s`);
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

if (import.meta.main) {
  await main().catch((error) => {
    console.error(`record-providers: ${(error as Error).message}`);
    process.exit(1);
  });
}
