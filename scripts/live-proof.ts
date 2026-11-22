#!/usr/bin/env bun
// Live proof: one real task through the whole factory path.
//   bun scripts/live-proof.ts [--task "..."] [--plan "..."] [--keep]
// Creates a scratch git project, registers it, states the task, drafts
// and approves the plan, then runs the dispatcher pipeline (builder
// station, then a separate QC station) with the real agent command
// (muse exec; override with FACTORY_AGENT_COMMAND for a stub), and
// prints the resulting state and diff. The scratch project is kept so
// the worktree diff can be inspected; delete the printed dir to clean.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskPipeline, taskDiff } from "../src/crew/dispatch";
import { FactoryStore } from "../src/crew/store";
import { approvePlan, draftPlan, newTask } from "../src/crew/task";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const taskText = arg(
  "task",
  "Add a greet(name) function to hello.ts that returns `hello, <name>`, with a bun test proving it, and make the tests pass.",
);
const planText = arg(
  "plan",
  "1. Read the repo. 2. Implement greet(name) in hello.ts. 3. Add hello.test.ts covering it. 4. Run bun test and make it pass.",
);

const base = mkdtempSync(join(tmpdir(), "live-proof-"));
const repo = join(base, "app");
const git = (args: string) =>
  execSync(`git -c user.name=proof -c user.email=proof@local ${args}`, {
    cwd: repo,
    encoding: "utf8",
  });
execSync(`mkdir -p "${repo}"`);
await Bun.write(join(repo, "hello.ts"), `export const placeholder = true;\n`);
await Bun.write(join(repo, "README.md"), "# live-proof scratch project\n");
git("init -q");
git("add -A");
git("commit -qm init");

const store = new FactoryStore(join(base, "store"));
await store.registerProject("proof", repo, {
  name: "live-proof",
});
const now = new Date().toISOString();
let task = newTask(
  {
    id: "task-proof",
    projectId: "proof",
    title: taskText.slice(0, 80),
    prompt: taskText,
  },
  now,
);
task = approvePlan(draftPlan(task, planText, now), now);
await store.writeTask(task);
await store.appendPrompt(task.id, {
  at: now,
  kind: "user",
  text: taskText,
});
console.log(`proof: task stated and plan approved; dispatching (project ${repo})`);

const command = process.env.FACTORY_AGENT_COMMAND?.split(" ").filter(Boolean);
const done = await runTaskPipeline(task.id, {
  store,
  command,
  timeoutMs: 15 * 60_000,
});
const prompts = await store.listPrompts(task.id);
console.log(`proof: final state: ${done.state}`);
for (const p of prompts) console.log(`proof: [${p.kind}] ${p.text.split("\n")[0]}`);
console.log("proof: --- diff of the task worktree ---");
console.log(taskDiff(done) || "(no diff)");
console.log(`proof: evidence kept at ${base} (worktree: ${done.worktree}); delete it to clean up`);
if (done.state !== "done") process.exit(1);
