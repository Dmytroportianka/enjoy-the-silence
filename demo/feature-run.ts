// Shared bootstrap for the recorded feature run and its no-video test twin.
// Both drive the REAL pipeline (triage -> plan -> dual red-team -> build ->
// review bounce -> land -> retro) fully offline, with demo/pipeline-stub.ts
// as the mocked Muse instance: same job-card contract, same JSONL, zero
// tokens. The recorder adds the dashboard + a browser; the test adds nothing.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlanPipeline, runTaskPipeline } from "../src/crew/dispatch";
import { FactoryStore } from "../src/crew/store";
import { newTask } from "../src/crew/task";

export const FEATURE_PROMPT = "add a hello service and expose it at /hello";
export const FEATURE_TITLE = "hello service";
export const SHOWCASE_PROMPT =
  "add a status page at /status showing service health as JSON and HTML, with tests";
export const SHOWCASE_TITLE = "status page";
export const PROJECT_ID = "demo";

// The mocked Muse every station speaks to: the same command the recorder
// hands the pipeline and the dashboard (DASHBOARD_AGENT_COMMAND), so the
// dashboard's own retro sweep stays offline too.
export const STUB_COMMAND = [
  "bun",
  join(import.meta.dir, "pipeline-stub.ts"),
];

// The demo app's gate: a plain node script, so the pipeline's npm-run verify
// works anywhere node does (no install step in the temp repo). Attempt one
// passes verify with a smoke check that is too weak to mean anything; the
// coder reviewer bounces it; attempt two pins the greeting and converges.
const PACKAGE_JSON = [
  "{",
  '  "name": "demo-app",',
  '  "private": true,',
  '  "scripts": {',
  '    "verify": "node verify.js"',
  "  }",
  "}",
  "",
].join("\n");

const VERIFY_JS = [
  'const { existsSync, readdirSync } = require("node:fs");',
  'for (const file of readdirSync(".").filter((f) => f.endsWith(".test.js")).sort()) require("./" + file);',
  'console.log("verify: smoke check passed");',
  "",
].join("\n");

const SERVER_JS = [
  'const { createServer } = require("node:http");',
  'const { existsSync } = require("node:fs");',
  "const server = createServer((req, res) => {",
  '  if (req.url === "/hello" && existsSync("./hello.js")) { res.writeHead(200, { "content-type": "text/plain" }); res.end(require("./hello.js").hello()); return; }',
  '  if (req.url === "/status" && existsSync("./status.js")) { const s = require("./status.js"); if ((req.headers.accept ?? "").includes("application/json")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(s.statusJson())); } else { res.writeHead(200, { "content-type": "text/html" }); res.end(s.statusPage()); } return; }',
  '  res.writeHead(404, { "content-type": "text/plain" }); res.end("not found");',
  "});",
  'server.listen(Number(process.env.PORT ?? 0), "127.0.0.1");',
  "",
].join("\n");

/**
 * A temp project the pipeline can manufacture in: a git repo with a real
 * (if tiny) app and a stated verify gate. The store registers it so the
 * dashboard has a project to show on the floor.
 */
export async function prepareFeatureRepo(base?: string): Promise<{
  root: string;
  repo: string;
  store: FactoryStore;
}> {
  const root = base ?? mkdtempSync(join(tmpdir(), "feature-run-"));
  const repo = join(root, "app");
  mkdirSync(repo, {
    recursive: true,
  });
  const git = (args: string) =>
    execSync(`git ${args}`, {
      cwd: repo,
      encoding: "utf8",
    });
  git("init -q -b main");
  // Identity lives in the repo config so pipeline commits (which run plain
  // `git commit`) work on machines without a global identity.
  git("config user.name factory");
  git("config user.email factory@local");
  writeFileSync(join(repo, "package.json"), PACKAGE_JSON);
  writeFileSync(join(repo, "verify.js"), VERIFY_JS);
  writeFileSync(join(repo, "server.js"), SERVER_JS);
  writeFileSync(join(repo, "README.md"), "# demo app\n");
  git("add -A");
  git("commit -qm seed");
  const store = new FactoryStore(join(root, "store"));
  await store.registerProject(PROJECT_ID, repo);
  return {
    root,
    repo,
    store,
  };
}

/** State the work order: one task in the store, owner prompt on record. */
export async function submitFeatureTask(store: FactoryStore, taskId: string): Promise<void> {
  const now = new Date().toISOString();
  const task = newTask(
    {
      id: taskId,
      projectId: PROJECT_ID,
      title: FEATURE_TITLE,
      prompt: FEATURE_PROMPT,
    },
    now,
  );
  await store.writeTask(task);
  await store.appendPrompt(taskId, {
    at: now,
    kind: "user",
    text: FEATURE_PROMPT,
  });
}

/**
 * Run the whole feature through the real pipeline with the stub as Muse.
 * autoApprove stands in for the owner's click (the settings toggle the
 * dashboard offers), so the run is unattended from one sentence to done.
 */
export async function runFeaturePipeline(
  store: FactoryStore,
  taskId: string,
  options: {
    stub?: string;
  } = {},
): Promise<import("../src/crew/task").Task> {
  const command = options.stub
    ? [
        "bun",
        options.stub,
      ]
    : STUB_COMMAND;
  const shared = {
    store,
    command,
    autoApprove: true,
  };
  await runPlanPipeline(taskId, shared);
  await runTaskPipeline(taskId, shared);
  const task = await store.readTask(taskId);
  if (!task) throw new Error(`feature run: task ${taskId} disappeared from the store`);
  return task;
}
