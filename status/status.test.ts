import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryStore } from "../src/crew/store";
import { DEFAULT_ANSWERS, generateWizardFiles } from "../src/wizard";
import { basicAuthOk, failuresFor, parseClaudeSessions, parsePorts, parseProcesses } from "./lib";

describe("status parsers (ported, sessions replace tmux panes)", () => {
  test("parseClaudeSessions keeps only muse exec, extracts resume ids", () => {
    const ps = [
      "  101 02:31 muse exec --json do the thing",
      "  102 00:05 muse exec --json --session-id abc-123 resume it",
      "  103 10:00 bash -lc sleep 99",
      "  104 01:00 claude --print hi",
    ].join("\n");
    const sessions = parseClaudeSessions(ps);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      pid: 101,
      sessionId: null,
      resumed: false,
    });
    expect(sessions[1]).toMatchObject({
      pid: 102,
      sessionId: "abc-123",
      resumed: true,
    });
  });

  test("parseProcesses / parsePorts / failuresFor", () => {
    expect(parseProcesses(" 10 5.0 1.0 bun\nbad line\n 20 1.0 0.5 muse")[0]).toMatchObject({
      pid: 10,
      cmd: "bun",
    });
    expect(parsePorts('LISTEN 0 4096 127.0.0.1:8123 0.0.0.0:* users:(("bun",pid=1,fd=9))')).toEqual(
      [
        {
          local: "127.0.0.1:8123",
          process: "bun",
        },
      ],
    );
    expect(
      failuresFor({
        units: [
          {
            id: "gitea.service",
            activeState: "failed",
          },
          {
            id: "x.service",
            activeState: "active",
          },
        ],
      }),
    ).toEqual([
      {
        kind: "unit",
        name: "gitea.service",
      },
    ]);
    expect(failuresFor(null)).toEqual([
      {
        kind: "host",
        name: "unreachable",
      },
    ]);
  });

  test("basicAuthOk fails closed", async () => {
    const hash = await Bun.password.hash("secret");
    const good = "Basic " + btoa("admin:secret");
    expect(await basicAuthOk(good, "admin", hash)).toBe(true);
    expect(await basicAuthOk("Basic " + btoa("admin:wrong"), "admin", hash)).toBe(false);
    expect(await basicAuthOk(good, "admin", "")).toBe(false);
    expect(await basicAuthOk(null, "admin", hash)).toBe(false);
  });
});

// Server e2e: mock system binaries (env-overridable paths, like the
// reference) and verify /state plus the terminal backdoor. The terminal
// check doubles as the scaffold e2e: it greps wizard-generated files from
// inside the "VM" (this process) exactly as an operator would in Incus.
const procs: Array<{
  kill: () => void;
}> = [];
afterAll(() => procs.forEach((p) => p.kill()));

function mockBin(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function startStatus(env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "server.ts"),
    ],
    {
      env: {
        ...process.env,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  procs.push(proc);
  const base = `http://127.0.0.1:${env.STATUS_PORT}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return base;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  throw new Error("status server did not start");
}

describe("status server e2e (mock binaries + terminal backdoor)", () => {
  test("/state reports units, muse sessions, stations; terminal verifies a scaffold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "status-e2e-"));
    const mocks = join(dir, "bin");
    mkdirSync(mocks);
    const systemctl = mockBin(
      mocks,
      "systemctl",
      'if [ "$1" = list-units ]; then echo "gitea.service loaded active running Gitea"; echo "agent-factory-status.service loaded active running status"; else printf "Id=$2\\nDescription=Mock\\nActiveState=active\\nSubState=running\\nExecMainStartTimestamp=\\nMemoryCurrent=1048576\\n"; fi',
    );
    const journalctl = mockBin(mocks, "journalctl", 'echo "mock log line"');
    const ps = mockBin(
      mocks,
      "ps",
      'case "$*" in *etime*) printf " 201 03:12 muse exec --json build it\\n 202 01:00 muse exec --json --session-id sess-9 resume\\n";; *) printf " 201 2.0 1.0 muse\\n 55 0.1 0.1 bash\\n";; esac',
    );
    const ss = mockBin(
      mocks,
      "ss",
      "echo 'LISTEN 0 4096 0.0.0.0:8123 0.0.0.0:* users:((\"bun\",pid=1,fd=9))'",
    );
    const df = mockBin(
      mocks,
      "df",
      'printf "Filesystem Size Used Avail Use%% Mounted\\n/dev/x 10G 5G 5G 50%% /\\n"',
    );

    const dataDir = join(dir, "data");
    const store = new FactoryStore(dataDir);
    await store.writeCard({
      id: "s1",
      jobId: "job1",
      role: "builder",
      task: "build hello",
      worktree: dir,
      constraints: [],
      gates: [],
    });
    await store.setSession("job1", "s1", "sess-9");

    // The scaffold under test: deterministic wizard output in a temp dir.
    const scaffoldDir = join(dir, "scaffold");
    mkdirSync(scaffoldDir);
    for (const [name, content] of generateWizardFiles({
      ...DEFAULT_ANSWERS,
      target: "incus",
    })) {
      await Bun.write(join(scaffoldDir, name), content);
    }

    const base = await startStatus({
      STATUS_PORT: "18123",
      STATUS_BIND: "127.0.0.1",
      FACTORY_DATA: dataDir,
      STATUS_SYSTEMCTL: systemctl,
      STATUS_JOURNALCTL: journalctl,
      STATUS_PS: ps,
      STATUS_SS: ss,
      STATUS_DF: df,
      STATUS_TERMINAL_CWD: scaffoldDir,
    });

    const state = (await (await fetch(`${base}/state`)).json()) as {
      ok: boolean;
      units: Array<{
        id: string;
        activeState: string;
      }>;
      sessions: Array<{
        pid: number;
        sessionId: string | null;
      }>;
      stations: Array<{
        stationId: string;
        sessionId: string | null;
      }>;
    };
    expect(state.units.map((u) => u.id).sort()).toEqual([
      "agent-factory-status.service",
      "gitea.service",
    ]);
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions[1]?.sessionId).toBe("sess-9");
    expect(state.stations[0]).toMatchObject({
      stationId: "s1",
      sessionId: "sess-9",
    });

    // Terminal backdoor = scaffold e2e: prove the generated files are real.
    const exec = (await (
      await fetch(`${base}/api/terminal/exec`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command:
            "grep -q 'networking.hostName = \"agent-os-demo\"' configuration.nix && test -f run-incus.sh && echo SCAFFOLD_OK",
        }),
      })
    ).json()) as {
      code: number;
      output: string;
    };
    expect(exec.code).toBe(0);
    expect(exec.output).toContain("SCAFFOLD_OK");
  }, 20_000);

  test("terminal requires basic auth when a hash is configured", async () => {
    const hash = await Bun.password.hash("secret");
    const base = await startStatus({
      STATUS_PORT: "18124",
      STATUS_BIND: "127.0.0.1",
      STATUS_AUTH_PASS_HASH: hash,
      FACTORY_DATA: mkdtempSync(join(tmpdir(), "status-auth-")),
    });
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/api/terminal/exec`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          command: "echo AUTH_OK",
        }),
      });
    expect((await post({})).status).toBe(401);
    const ok = (await (
      await post({
        authorization: "Basic " + btoa("admin:secret"),
      })
    ).json()) as {
      output: string;
    };
    expect(ok.output).toContain("AUTH_OK");
  }, 20_000);
});
