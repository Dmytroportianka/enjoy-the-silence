import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Loopback must bypass any proxy from the environment: with http_proxy
// set and NO_PROXY empty, Bun fetch routes 127.0.0.1 through the proxy
// and every request hangs until the test timeout (the reported flake).
for (const key of [
  "NO_PROXY",
  "no_proxy",
]) {
  const parts = (process.env[key] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const host of [
    "127.0.0.1",
    "localhost",
  ])
    if (!parts.includes(host)) parts.push(host);
  process.env[key] = parts.join(",");
}

// E2E for the control room's project adoption: register a real folder from
// the API the button calls, see it listed, watch it go stale, sync it.
const base = mkdtempSync(join(tmpdir(), "dash-test-"));
const dataDir = join(base, "factory-data");
const stub = join(base, "stub.ts");
await Bun.write(
  stub,
  [
    `import { writeFileSync } from "node:fs";`,
    `import { join } from "node:path";`,
    `const prompt = process.argv[process.argv.length - 1] ?? "";`,
    `let text = "built the feature";`,
    `if (prompt.includes("Write the implementation plan")) { writeFileSync(join(process.cwd(), "PLAN-DRAFT.md"), "# Intent\\nDo it.\\n## Why\\nNeeded.\\n## Approach\\nSteps.\\n## Success criteria\\ntests pass\\n"); text = "PLAN_WRITTEN"; }`,
    `else if (prompt.includes("Scout this codebase")) { writeFileSync(join(process.cwd(), "SCOUT.json"), JSON.stringify({ description: "a candle shop app", rules: "never discount over 20%", smeSoul: "You are a candle retail expert.", coderSoul: "You are a pragmatic TypeScript coder." })); text = "SCOUT_DONE"; }`,
    `else if (prompt.includes("Red-team this plan")) text = "PASS red-team ok";`,
    `else if (prompt.includes("Review as")) text = "PASS review ok";`,
    `else writeFileSync(join(process.cwd(), "verification.webm"), "fake-video-bytes");`,
    `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-1" }, payload_type: "run.output.delta", payload: { text: "working…\\n" } }));`,
    `await Bun.sleep(400);`,
    `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-1" }, payload_type: "run.terminal.completed", payload: { text } }));`,
  ].join("\n"),
);
// The server serves the built React SPA; build it like production does.
execSync("bun x vite build --config dashboard/vite.config.ts", {
  cwd: join(import.meta.dir, ".."),
  stdio: "ignore",
});
// Ask the OS for a free ephemeral port instead of drawing from a shared
// 4600-5099 range that a leaked server from a prior run can hold.
const probe = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response("probe"),
});
const port = probe.port;
probe.stop(true);
const serverOutLog = join(base, "server-stdout.log");
const serverErrLog = join(base, "server-stderr.log");
const proc = Bun.spawn(
  [
    "bun",
    join(import.meta.dir, "server.ts"),
  ],
  {
    env: {
      ...process.env,
      FACTORY_DATA: dataDir,
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: "127.0.0.1",
      DASHBOARD_AGENT_COMMAND: `bun ${stub}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
// Drain pipes to files: an unread pipe blocks the server when full, and
// the logs are the evidence when a test times out.
function drainToFile(stream: ReadableStream<Uint8Array>, path: string): void {
  void (async () => {
    const sink = Bun.file(path).writer();
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sink.write(value);
      }
    } catch {
      // server gone
    } finally {
      try {
        sink.end();
      } catch {
        // already ended
      }
    }
  })();
}
drainToFile(proc.stdout, serverOutLog);
drainToFile(proc.stderr, serverErrLog);
console.log(`dashboard under test on 127.0.0.1:${port} (logs: ${serverOutLog} ${serverErrLog})`);
afterAll(async () => {
  proc.kill();
  await proc.exited.catch(() => {});
});

async function waitUp(): Promise<string> {
  const url = `http://127.0.0.1:${port}`;
  const start = Date.now();
  let last = "no attempt yet";
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${url}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return url;
      last = `healthz status ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(100);
  }
  const { readFileSync } = await import("node:fs");
  const tail = (p: string) => {
    try {
      return readFileSync(p, "utf8").slice(-2000);
    } catch {
      return "(no log)";
    }
  };
  throw new Error(
    `dashboard server did not start after ${Date.now() - start}ms; last: ${last}\nstdout:\n${tail(serverOutLog)}\nstderr:\n${tail(serverErrLog)}`,
  );
}

// Served page plus its JS bundle: UI feature strings live in the bundle.
// Fetched once per file: re-fetching ~350KB inside every API test only
// adds load to the timed path without asserting anything new.
const bundleCache = new Map<string, Promise<string>>();
async function uiBundle(url: string): Promise<string> {
  let cached = bundleCache.get(url);
  if (!cached) {
    cached = (async () => {
      const page = await (
        await fetch(`${url}/`, {
          signal: AbortSignal.timeout(10_000),
        })
      ).text();
      const src = page.match(/src="(\/assets\/[^"]+\.js)"/)?.[1] ?? "";
      const js = src
        ? await (
            await fetch(`${url}${src}`, {
              signal: AbortSignal.timeout(10_000),
            })
          ).text()
        : "";
      return page + js;
    })();
    bundleCache.set(url, cached);
  }
  return cached;
}

// Bounded poll that fails with what it was waiting for, the last observed
// value, and elapsed time, instead of an opaque test timeout.
async function waitFor(
  label: string,
  check: () => Promise<{
    done: boolean;
    last: string;
  }>,
  opts?: {
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const intervalMs = opts?.intervalMs ?? 200;
  const start = Date.now();
  let last = "no attempts yet";
  for (;;) {
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0)
      throw new Error(
        `timed out waiting for ${label} after ${Date.now() - start}ms; last: ${last}`,
      );
    const seen = await Promise.race([
      check(),
      Bun.sleep(remaining).then(() => {
        throw new Error(
          `timed out waiting for ${label} after ${Date.now() - start}ms; last: ${last}`,
        );
      }),
    ]);
    last = seen.last;
    if (seen.done) return last;
    await Bun.sleep(intervalMs);
  }
}

// Pause new dispatcher launches while a test asserts a pure API surface,
// then restore the previous value. In-flight pipelines finish on their own.
async function pauseDispatch(url: string): Promise<() => Promise<void>> {
  const before = (await (await fetch(`${url}/api/settings`)).json()) as {
    dispatchEnabled: boolean;
  };
  await fetch(`${url}/api/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      dispatchEnabled: false,
    }),
  });
  return async () => {
    await fetch(`${url}/api/settings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        dispatchEnabled: before.dispatchEnabled,
      }),
    }).catch(() => {});
  };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
describe("dashboard projects API (register button backend)", () => {
  test("register -> list -> stale -> sync, and bad input is refused", async () => {
    const url = await waitUp();
    const folder = join(base, "my-app");
    mkdirSync(folder, {
      recursive: true,
    });
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: folder,
        encoding: "utf8",
      });
    git("init -q");
    await Bun.write(join(folder, "a.txt"), "one\n");
    git("add a.txt");
    git("commit -qm one");

    const bad = await fetch(`${url}/api/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "../evil",
        folderPath: folder,
      }),
    });
    expect(bad.status).toBe(400);

    const reg = await fetch(`${url}/api/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "my-app",
        folderPath: folder,
        name: "My App",
      }),
    });
    expect(reg.status).toBe(200);
    const regBody = (await reg.json()) as {
      project: {
        id: string;
        repoPath: string;
        lastCommit: string;
      };
    };
    expect(regBody.project.repoPath).toBe(folder);
    expect(existsSync(join(folder, "data", "project.json"))).toBe(true);

    let list = (await (await fetch(`${url}/api/projects`)).json()) as {
      projects: {
        id: string;
        online: boolean;
        stale: boolean;
      }[];
    };
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0]).toMatchObject({
      id: "my-app",
      online: true,
      stale: false,
    });

    await Bun.write(join(folder, "a.txt"), "two\n");
    git("commit -qam two");
    list = (await (await fetch(`${url}/api/projects`)).json()) as {
      projects: {
        id: string;
        online: boolean;
        stale: boolean;
      }[];
    };
    expect(list.projects[0]?.stale).toBe(true);

    const sync = await fetch(`${url}/api/projects/my-app/sync`, {
      method: "POST",
    });
    expect(sync.status).toBe(200);
    list = (await (await fetch(`${url}/api/projects`)).json()) as {
      projects: {
        id: string;
        online: boolean;
        stale: boolean;
      }[];
    };
    expect(list.projects[0]?.stale).toBe(false);

    const page = await uiBundle(url);
    expect(page).toContain("Register project folder");
    expect(page).toContain("Sync to current commit");
  }, 60_000);

  test("project context sets the SME soul and persists", async () => {
    const url = await waitUp();
    const res = await fetch(`${url}/api/projects/my-app/context`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        description: "candle shop",
        businessPlan: "subscription boxes",
        rules: "never discount over 20%",
        goals: "grow retention\nship weekly",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      smePersona: string;
      project: {
        goals: string[];
      };
    };
    expect(body.smePersona).toContain("never discount over 20%");
    expect(body.project.goals).toEqual([
      "grow retention",
      "ship weekly",
    ]);
    const listed = (await (await fetch(`${url}/api/projects`)).json()) as {
      projects: {
        id: string;
        smePersona: string;
      }[];
    };
    expect(listed.projects.find((p) => p.id === "my-app")?.smePersona).toContain(
      "subscription boxes",
    );
    const page = await uiBundle(url);
    expect(page).toContain("sets the SME soul");
    expect(page).toContain("Effective SME soul");
  }, 30_000);

  test("dev mode: configure, run, reach, stop a project dev server", async () => {
    const url = await waitUp();
    // Disjoint from the server's own range (4600-5099, chosen above): a
    // colliding devPort once served the control room HTML instead of the
    // dev app and failed this test. Keep 5200-5399 out of every other
    // test's range too.
    const devPort = 5200 + Math.floor(Math.random() * 200);
    const cfg = await fetch(`${url}/api/projects/my-app/dev-config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        devCommand: `bun -e "Bun.serve({port: process.env.PORT, fetch: () => new Response('dev-ok')})"`,
        devPort,
        testMode: "dev",
      }),
    });
    expect(cfg.status).toBe(200);
    const listed = (await (await fetch(`${url}/api/projects`)).json()) as {
      projects: {
        id: string;
        testMode: string;
      }[];
    };
    expect(listed.projects.find((p) => p.id === "my-app")?.testMode).toBe("dev");
    const started = await fetch(`${url}/api/projects/my-app/dev/start`, {
      method: "POST",
    });
    expect(started.status).toBe(200);
    let body = "";
    for (let i = 0; i < 30; i++) {
      body = await fetch(`http://127.0.0.1:${devPort}/`)
        .then((r) => r.text())
        .catch(() => "");
      if (body === "dev-ok") break;
      await Bun.sleep(200);
    }
    expect(body).toBe("dev-ok");
    const status = (await (await fetch(`${url}/api/projects/my-app/dev`)).json()) as {
      running: boolean;
      log: string[];
    };
    expect(status.running).toBe(true);
    expect(status.log.join("\n")).toContain("dev-ok".length ? "Bun.serve" : "");
    await fetch(`${url}/api/projects/my-app/dev/stop`, {
      method: "POST",
    });
    await Bun.sleep(300);
    const after = (await (await fetch(`${url}/api/projects/my-app/dev`)).json()) as {
      running: boolean;
    };
    expect(after.running).toBe(false);
    const page = await uiBundle(url);
    expect(page).toContain("Run dev");
    expect(page).toContain("Open dev app");
  }, 60_000);

  test("state task -> draft plan -> approve -> dispatcher runs it to done", async () => {
    const url = await waitUp();
    // This test drives the MANUAL plan flow, so pin click-mode: in auto
    // mode the approval tick can approve-and-dispatch the drafted plan in
    // the gap between planning finishing and the hand-written plan save
    // below (the race made POST /plan return 400 cannot-draft-while-
    // running and made this test flake). Restored in finally so later
    // tests and the next file run keep the auto default.
    await fetch(`${url}/api/settings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        approvalMode: "click",
      }),
    });
    try {
      const created = await fetch(`${url}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: "my-app",
          prompt: "add hello service and expose it at /hello",
        }),
      });
      expect(created.status).toBe(200);
      const { task } = (await created.json()) as {
        task: {
          id: string;
          state: string;
          planRequested: boolean;
        };
      };
      expect(task.state).toBe("planned");
      expect(task.planRequested).toBe(true); // planning starts automatically, no Generate click

      const generated = await fetch(`${url}/api/tasks/${task.id}/generate-plan`, {
        method: "POST",
      });
      expect(generated.status).toBe(202); // async: planning runs in background
      let genBody: {
        planArtifact: string;
        planning: boolean;
      } | null = null;
      for (let i = 0; i < 30; i++) {
        const detail = (await (await fetch(`${url}/api/tasks/${task.id}`)).json()) as {
          planArtifact: string;
          planning: boolean;
        };
        if (!detail.planning && detail.planArtifact) {
          genBody = detail;
          break;
        }
        await Bun.sleep(200);
      }
      expect(genBody?.planArtifact).toContain("outside reviewer");

      const planned = await fetch(`${url}/api/tasks/${task.id}/plan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          plan: "1. add route 2. test",
        }),
      });
      expect(planned.status).toBe(200);
      const approved = await fetch(`${url}/api/tasks/${task.id}/approve`, {
        method: "POST",
      });
      expect(approved.status).toBe(200);

      // Dispatcher tick (3s) + stub pipeline should land it in Done.
      let state = "";
      for (let i = 0; i < 40; i++) {
        const detail = (await (await fetch(`${url}/api/tasks/${task.id}`)).json()) as {
          task: {
            state: string;
          };
          prompts: unknown[];
        };
        state = detail.task.state;
        if (state === "done") {
          expect(detail.prompts.length).toBeGreaterThanOrEqual(3);
          break;
        }
        await Bun.sleep(500);
      }
      expect(state).toBe("done");
      const detailDone = (await (await fetch(`${url}/api/tasks/${task.id}`)).json()) as {
        artifacts: string[];
      };
      expect(detailDone.artifacts).toContain("verification.webm");
      const video = await fetch(`${url}/api/tasks/${task.id}/artifacts/verification.webm`);
      expect(video.status).toBe(200);
      expect(video.headers.get("content-type")).toContain("video/webm");
      const diff = (await (await fetch(`${url}/api/tasks/${task.id}/diff`)).json()) as {
        diff: string;
      };
      expect(diff.diff).toContain("git status");
      const cap = (await (await fetch(`${url}/api/capacity`)).json()) as {
        maxParallelTasks: number;
        queued: number;
      };
      expect(cap.maxParallelTasks).toBeGreaterThanOrEqual(1);
      expect(cap.queued).toBe(0); // the finished task left the queue
      const page = await uiBundle(url);
      expect(page).toContain("State a task");
      expect(page).toContain("Approve plan");
      expect(page).toContain("Done (recent)");
      // A task opens on its own page, away from the board.
      // No Back button: the sidebar Board nav covers returning.
      expect(page).not.toContain("Back to board");
      // Task view is split: active question/answer left, scrollable history
      // right; title/nav live in a sidebar.
      expect(page).toContain("task-active");
      expect(page).toContain("task-history");
      expect(page).toContain("History & state");
      // Folded sections are Material-style accordions with rotating chevrons.
      expect(page).toContain("rotate-180");
      expect(page).toContain("Agent Factory — Control Room");
      // Features-page remove is a quiet icon button, not a big red block:
      // its accessible name is in the bundle, while the Inbox keeps the
      // labelled danger button.
      expect(page).toContain("Remove feature permanently");
      // Project page leads with work summary (done/doing/waiting) and a
      // settings panel; the manual Roadmap is gone; CI analysis is shown.
      expect(page).toContain("Work on this project");
      expect(page).toContain("Project settings");
      expect(page).toContain("CI — what gates this project");
      expect(page).not.toContain("A manual list you keep by hand");
      // Planning is automatic: no Generate button anywhere; a task with
      // no plan yet reads as queued for a slot instead.
      expect(page).not.toContain("Generate plan with agents");
      expect(page).toContain("In queue to start planning whenever a slot frees");
      const projects = (await (await fetch(`${url}/api/projects`)).json()) as {
        projects: {
          id: string;
          ci: {
            workflows: unknown[];
            suggestedVerify: string;
          } | null;
        }[];
      };
      const mine = projects.projects.find((x) => x.id === "my-app");
      expect(mine?.ci).not.toBeNull();
      expect(mine?.ci?.workflows).toEqual([]);
      // Client routes are real URLs: deep links serve the SPA shell.
      const deep = await fetch(`${url}/tasks/${task.id}`);
      expect(deep.status).toBe(200);
      expect(await deep.text()).toContain('id="root"');
      const deepProject = await fetch(`${url}/projects/my-app`);
      expect(deepProject.status).toBe(200);
    } finally {
      await fetch(`${url}/api/settings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          approvalMode: "auto",
        }),
      }).catch(() => {});
    }
  }, 60_000);

  test("task stated on disk (not via the form) is auto-queued for planning; retro-point is not", async () => {
    const url = await waitUp();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const now = new Date().toISOString();
    const writeRawTask = (id: string, tags: string[]) => {
      mkdirSync(join(dataDir, "tasks", id), {
        recursive: true,
      });
      writeFileSync(
        join(dataDir, "tasks", id, "task.json"),
        JSON.stringify({
          id,
          projectId: "my-app",
          title: id,
          prompt: "add hello service and expose it at /hello",
          jobId: id,
          plan: "",
          planState: "none",
          state: "planned",
          planRequested: false,
          tags,
          createdAt: now,
          updatedAt: now,
        }),
      );
    };
    writeRawTask("task-autoplan-sweep", []);
    writeRawTask("task-retro-point-sweep", [
      "retro-point",
    ]);
    let queued = false;
    for (let i = 0; i < 50 && !queued; i++) {
      const detail = (await (await fetch(`${url}/api/tasks/task-autoplan-sweep`)).json()) as {
        task: {
          planRequested: boolean;
          planState: string;
        };
        planArtifact: string | null;
        planning: boolean;
        prompts: {
          text: string;
        }[];
      };
      // Queued, running, already drafted, or even auto-failed (the
      // system note proves it was picked with no Generate click; a
      // finished draft and a cleared-after-failure flag both reset
      // planRequested, so the flag alone would race the planner).
      queued =
        detail.task.planRequested ||
        detail.planning ||
        detail.task.planState !== "none" ||
        !!detail.planArtifact ||
        detail.prompts.some((p) => p.text.startsWith("planning failed:"));
      if (!queued) await Bun.sleep(300);
    }
    expect(queued).toBe(true); // no Generate click: the sweep queued it
    const retro = (await (await fetch(`${url}/api/tasks/task-retro-point-sweep`)).json()) as {
      task: {
        planRequested: boolean;
      };
    };
    expect(retro.task.planRequested).toBe(false); // candidates still wait for the owner's accept
  }, 30_000);

  test("task intake: concrete prompt without magic keywords accepted, vague still 422, no file:// in page", async () => {
    const url = await waitUp();
    const vague = await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: "my-app",
        prompt: "fix it",
      }),
    });
    expect(vague.status).toBe(422);
    const concrete = await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: "my-app",
        prompt: "fix the login bug on the settings screen",
      }),
    });
    expect(concrete.status).toBe(200);
    // The served shell must never reference file:// (library bundles may
    // contain the string internally; that is not a page reference).
    const page = await (await fetch(`${url}/`)).text();
    expect(page).not.toContain("file://");
  }, 30_000);

  test("plan-comments: empty comments refused, plan renders per line not as textarea", async () => {
    const url = await waitUp();
    const resumeDispatch = await pauseDispatch(url);
    try {
      const created = await fetch(`${url}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: "my-app",
          prompt: "fix the plan comments layout on the settings screen",
        }),
      });
      const { task } = (await created.json()) as {
        task: {
          id: string;
        };
      };
      const empty = await fetch(`${url}/api/tasks/${task.id}/plan-comments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          comments: [],
        }),
      });
      expect(empty.status).toBe(400);
      const noPlan = await fetch(`${url}/api/tasks/${task.id}/plan-comments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          comments: [
            {
              line: 1,
              text: "x",
              comment: "change it",
            },
          ],
        }),
      });
      expect(noPlan.status).toBe(400);
      const page = await uiBundle(url);
      // Plan and prompt render per line with click-to-comment fields.
      expect(page).toContain("Send comments to agent");
      expect(page).toContain("comment on this line");
      expect(page).toContain("comment on any line");
      // Plan lines render markdown (task-list markers, heading scale).
      expect(page).toContain("☐");
      // Only the plan scrolls; the column fills the screen height.
      expect(page).toContain("flex-1 min-h-0 overflow-y-auto");
      // Running tasks show worker output instead of plan commenting.
      expect(page).toContain("Worker output");
      expect(page).toContain("Edited files");
      expect(page).toContain("Agent feed");
    } finally {
      await resumeDispatch();
    }
  }, 60_000);

  test("scout gathers project info as accept-per-field suggestions", async () => {
    const url = await waitUp();
    const folder = join(base, "scout-app");
    mkdirSync(folder, {
      recursive: true,
    });
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: folder,
        encoding: "utf8",
      });
    git("init -q");
    await Bun.write(join(folder, "a.txt"), "one\n");
    git("add a.txt");
    git("commit -qm one");
    const reg = await fetch(`${url}/api/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "scout-app",
        folderPath: folder,
      }),
    });
    expect(reg.status).toBe(200);
    const scout = await fetch(`${url}/api/projects/scout-app/scout`, {
      method: "POST",
    });
    expect(scout.status).toBe(202);
    // Scout runs on its own (not via dispatcher); pausing dispatch after
    // launch only quiets unrelated stub pipelines during the poll.
    const resumeDispatch = await pauseDispatch(url);
    type Proj = {
      id: string;
      description: string;
      scouting: boolean;
      scoutSuggestions: {
        description: string;
        rules: string;
        smeSoul: string;
        coderSoul: string;
      } | null;
    };
    let found: Proj | undefined;
    try {
      await waitFor(
        "scout suggestions for scout-app",
        async () => {
          const list = (await (await fetch(`${url}/api/projects`)).json()) as {
            projects: Proj[];
          };
          found = list.projects.find((p) => p.id === "scout-app");
          return {
            done: !!found?.scoutSuggestions?.description,
            last: found
              ? `scouting=${found.scouting} suggestions=${JSON.stringify(found.scoutSuggestions)}`
              : "scout-app not listed",
          };
        },
        {
          timeoutMs: 20_000,
          intervalMs: 200,
        },
      );
    } finally {
      await resumeDispatch();
    }
    expect(found?.scoutSuggestions?.description).toBe("a candle shop app");
    expect(found?.scoutSuggestions?.rules).toContain("never discount");
    expect(found?.scoutSuggestions?.smeSoul).toContain("candle retail expert");
    expect(found?.scoutSuggestions?.coderSoul).toContain("pragmatic TypeScript coder");
    // Suggestions are not applied until the owner accepts them.
    expect(found?.description).toBe("");
    const page = await uiBundle(url);
    expect(page).toContain("Use suggestion");
    expect(page).toContain("Run scout again");
    // Project page can ask the scout to check again.
    expect(page).toContain("Re-check with scout");
    // Needs-input tasks surface their question with a focused reply box.
    expect(page).toContain("the agent is waiting for your answer");
    // Red-team REJECT reads as a processed review, not a failure.
    expect(page).toContain("Processed — points raised");
    expect(page).toContain("No open question — the worker was interrupted");
    // Input requests surface as 5s toasts, a bell with missed dot, and a requests page.
    expect(page).toContain("Requests for your input");
    expect(page).toContain("Worker needs input");
    expect(page).toContain("Ready for your approval");
    expect(page).toContain("Parallel tasks (max)");
    expect(page).toContain("Create task from this finding");
    expect(page).toContain("Send comments & questions to retro agent");
    // Sent input stays visible but disabled while the review runs.
    expect(page).toContain("Sent — review in progress");
  }, 60_000);

  test("verify-command can be set and cleared after stating", async () => {
    const url = await waitUp();
    const resumeDispatch = await pauseDispatch(url);
    try {
      const created = await fetch(`${url}/api/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: "my-app",
          prompt: "fix the verify command field on the settings screen",
          verifyCommand: "not a command",
        }),
      });
      const { task } = (await created.json()) as {
        task: {
          id: string;
        };
      };
      const saved = await fetch(`${url}/api/tasks/${task.id}/verify-command`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          verifyCommand: "",
        }),
      });
      expect(saved.status).toBe(200);
      const detail = (await (await fetch(`${url}/api/tasks/${task.id}`)).json()) as {
        task: {
          verifyCommand: string;
        };
      };
      expect(detail.task.verifyCommand).toBe("");
    } finally {
      await resumeDispatch();
    }
  }, 60_000);

  test("DELETE permanently removes a task; task page and board expose delete with confirm", async () => {
    const url = await waitUp();
    const created = await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: "my-app",
        prompt: "fix the delete button on the settings screen",
      }),
    });
    expect(created.status).toBe(200);
    const { task } = (await created.json()) as {
      task: {
        id: string;
      };
    };
    const missing = await fetch(`${url}/api/tasks/task-does-not-exist-xyz`, {
      method: "DELETE",
    });
    expect(missing.status).toBe(404);
    const del = await fetch(`${url}/api/tasks/${task.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(
      (
        (await del.json()) as {
          deleted: string;
        }
      ).deleted,
    ).toBe(task.id);
    const gone = await fetch(`${url}/api/tasks/${task.id}`);
    expect(gone.status).toBe(404);
    const again = await fetch(`${url}/api/tasks/${task.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
    const page = await uiBundle(url);
    expect(page).toContain("Delete task permanently");
    expect(page).toContain("unpushed, unmerged commits");
  }, 60_000);

  test("DELETE validates id, refuses cross-origin, and returns deleted/skipped shape", async () => {
    const url = await waitUp();
    const created = await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: "my-app",
        prompt: "delete guards check for origin handling",
      }),
    });
    const { task } = (await created.json()) as {
      task: {
        id: string;
      };
    };
    const bad = await fetch(`${url}/api/tasks/%252E%252E`, {
      method: "DELETE",
    });
    expect(bad.status).toBe(400);
    const cross = await fetch(`${url}/api/tasks/${task.id}`, {
      method: "DELETE",
      headers: {
        origin: "http://evil.example",
      },
    });
    expect(cross.status).toBe(403);
    expect((await fetch(`${url}/api/tasks/${task.id}`)).status).toBe(200); // refused delete left it in place, markers cleared
    const ok = await fetch(`${url}/api/tasks/${task.id}`, {
      method: "DELETE",
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      status: string;
      skipped: string[];
    };
    expect(body.status).toBe("deleted");
    expect(Array.isArray(body.skipped)).toBe(true);
  }, 60_000);

  test("registering with a pasted file:// folder URL registers the server path", async () => {
    const url = await waitUp();
    const folder = join(base, "file-app");
    mkdirSync(folder, {
      recursive: true,
    });
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: folder,
        encoding: "utf8",
      });
    git("init -q");
    await Bun.write(join(folder, "a.txt"), "one\n");
    git("add a.txt");
    git("commit -qm one");
    const reg = await fetch(`${url}/api/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "file-app",
        folderPath: `file://${folder}`,
      }),
    });
    expect(reg.status).toBe(200);
    const body = (await reg.json()) as {
      project: {
        repoPath: string;
      };
    };
    expect(body.project.repoPath).toBe(folder);
  }, 30_000);
});

describe("station live log (SSE)", () => {
  test("planner stream: parsed replay, raw JSONL, done event, and 404 for unknown", async () => {
    const url = await waitUp();
    const folder = join(base, "stream-app");
    mkdirSync(folder, {
      recursive: true,
    });
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: folder,
        encoding: "utf8",
      });
    git("init -q");
    await Bun.write(join(folder, "a.txt"), "one\n");
    git("add a.txt");
    git("commit -qm one");
    const reg = await fetch(`${url}/api/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "stream-app",
        folderPath: folder,
      }),
    });
    expect(reg.status).toBe(200);

    const created = await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId: "stream-app",
        prompt: "Add a hello endpoint to the app",
      }),
    });
    expect(created.status).toBe(200);
    const { task } = (await created.json()) as {
      task: {
        id: string;
      };
    };
    // The stub planner emits one delta line, sleeps, then the final answer.
    // Wait until its delivery exists so the buffer is guaranteed warm.
    let ran = false;
    for (let i = 0; i < 100 && !ran; i++) {
      const d = (await (await fetch(`${url}/api/tasks/${task.id}`)).json()) as {
        stations: {
          card: {
            id: string;
          };
          delivery: {
            status: string;
          } | null;
        }[];
      };
      ran = d.stations.some((s) => s.card.id === "planner" && s.delivery);
      if (!ran) await Bun.sleep(150);
    }
    expect(ran).toBe(true);

    const stream = await fetch(`${url}/api/stations/planner/stream`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const text = await stream.text();
    expect(text).toContain("working…");
    expect(text).toContain("PLAN_WRITTEN");
    expect(text).toContain("event: done");

    const raw = await fetch(`${url}/api/stations/planner/stream?raw=1`);
    expect(raw.status).toBe(200);
    const rawText = await raw.text();
    expect(rawText).toContain("run.output.delta");
    expect(rawText).toContain("event: done");

    expect((await fetch(`${url}/api/stations/nope/stream`)).status).toBe(404);
  }, 60_000);
});
