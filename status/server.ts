// status/server.ts — factory status page: the in-VM backdoor for checking
// that scaffolding (and the factory itself) works. Ported from the
// reference host/status server, with tmux panes replaced by Muse
// subsessions (separate `muse exec` processes + crew station sessions
// from the /data job cards).
//
//   STATUS_PORT (or PORT)  listen port (default 8123)
//   STATUS_BIND            bind address (default 127.0.0.1; factory: 0.0.0.0)
//   FACTORY_DATA           job-card dir (default ../factory-data; factory: /data)
//   STATUS_UNIT_PATTERNS   comma-separated regexes for systemd units
//   STATUS_AUTH_USER       basic-auth user for the terminal (default "admin")
//   STATUS_AUTH_PASS_HASH  bcrypt hash (Bun.password) for the terminal
//   STATUS_TERMINAL_CWD    terminal working directory (default $HOME)
// Command paths are env-overridable for deterministic tests:
//   STATUS_SYSTEMCTL, STATUS_JOURNALCTL, STATUS_PS, STATUS_SS, STATUS_DF
//
// Read paths (/state, page) are unauthenticated, LAN-style like the
// reference. The terminal (POST /api/terminal/exec) is a write path: it
// requires basic auth when STATUS_AUTH_PASS_HASH is set, runs only on a
// loopback bind when it is not, and is disabled on a public bind without
// a hash. It exists so a scaffold can be verified from inside the VM
// (the e2e backdoor) — treat the password as a root-equivalent secret.
import { execFile } from "node:child_process";
import * as os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basicAuthOk,
  failuresFor,
  type MuseSession,
  parseClaudeSessions,
  parsePorts,
  parseProcesses,
} from "./lib";

const run = promisify(execFile);
const PORT = Number(process.env.STATUS_PORT ?? process.env.PORT ?? "8123");
const BIND = process.env.STATUS_BIND ?? "127.0.0.1";
const AUTH_USER = process.env.STATUS_AUTH_USER ?? "admin";
const AUTH_PASS_HASH = process.env.STATUS_AUTH_PASS_HASH ?? "";
const TERMINAL_CWD = process.env.STATUS_TERMINAL_CWD ?? process.env.HOME ?? "/tmp";
const DATA_DIR = process.env.FACTORY_DATA ?? join(import.meta.dir, "..", "factory-data");

const SYSTEMCTL = process.env.STATUS_SYSTEMCTL ?? "/run/current-system/sw/bin/systemctl";
const JOURNALCTL = process.env.STATUS_JOURNALCTL ?? "/run/current-system/sw/bin/journalctl";
const PS_BIN = process.env.STATUS_PS ?? "/run/current-system/sw/bin/ps";
const SS_BIN = process.env.STATUS_SS ?? "/run/current-system/sw/bin/ss";
const DF_BIN = process.env.STATUS_DF ?? "/run/current-system/sw/bin/df";

const UNIT_PATTERNS = (process.env.STATUS_UNIT_PATTERNS ?? "gitea,agent-factory-.*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => new RegExp(s));
const UNIT_NAME_OK = /^[a-zA-Z0-9@:._\\-]+$/;
const BINARY_CANDIDATES: Record<string, string[]> = {
  muse: [
    "/run/current-system/sw/bin/muse",
    `${process.env.HOME ?? ""}/.local/bin/muse`,
  ],
  bun: [
    "/run/current-system/sw/bin/bun",
  ],
  git: [
    "/run/current-system/sw/bin/git",
  ],
};

type UnitState = {
  id: string;
  description: string;
  activeState: string;
  subState: string;
  since: string | null;
  memoryMb: number | null;
  journal: string[];
};

async function listUnits(): Promise<string[]> {
  try {
    const { stdout } = await run(
      SYSTEMCTL,
      [
        "list-units",
        "--type=service",
        "--no-legend",
        "--plain",
      ],
      {
        timeout: 5000,
      },
    );
    return stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0] ?? "")
      .filter((name) => UNIT_NAME_OK.test(name) && UNIT_PATTERNS.some((p) => p.test(name)));
  } catch {
    return [];
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
async function unitState(unit: string): Promise<UnitState> {
  const props = [
    "Id",
    "Description",
    "ActiveState",
    "SubState",
    "ExecMainStartTimestamp",
    "MemoryCurrent",
  ];
  let raw = "";
  try {
    raw = (
      await run(
        SYSTEMCTL,
        [
          "show",
          unit,
          ...props.map((p) => `-p${p}`),
        ],
        {
          timeout: 5000,
        },
      )
    ).stdout;
  } catch (e) {
    return {
      id: unit,
      description: unit,
      activeState: "unknown",
      subState: (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "error",
      since: null,
      memoryMb: null,
      journal: [],
    };
  }
  const map = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) map.set(line.slice(0, eq), line.slice(eq + 1));
  }
  let journal: string[] = [];
  try {
    journal = (
      await run(
        JOURNALCTL,
        [
          "-u",
          unit,
          "-n",
          "3",
          "-o",
          "cat",
          "--no-pager",
        ],
        {
          timeout: 5000,
        },
      )
    ).stdout
      .split("\n")
      .filter((l) => l.trim() !== "");
  } catch {
    /* journal unreadable is non-fatal */
  }
  const memNum = Number(map.get("MemoryCurrent") ?? "");
  return {
    id: map.get("Id") ?? unit,
    description: map.get("Description") ?? unit,
    activeState: map.get("ActiveState") ?? "unknown",
    subState: map.get("SubState") ?? "",
    since: map.get("ExecMainStartTimestamp") ?? null,
    memoryMb: Number.isFinite(memNum) && memNum > 0 ? memNum / 1e6 : null,
    journal,
  };
}

async function vitals() {
  let disk = {
    total: "",
    used: "",
    avail: "",
    pct: "",
  };
  try {
    const { stdout } = await run(
      DF_BIN,
      [
        "-h",
        "/",
      ],
      {
        timeout: 5000,
      },
    );
    const line = (stdout.split("\n")[1] ?? "").trim().split(/\s+/);
    disk = {
      total: line[1] ?? "",
      used: line[2] ?? "",
      avail: line[3] ?? "",
      pct: line[4] ?? "",
    };
  } catch {
    /* df unreadable is non-fatal */
  }
  let osName = "";
  try {
    const text = await Bun.file("/etc/os-release").text();
    osName =
      (text.split("\n").find((l) => l.startsWith("PRETTY_NAME=")) ?? "")
        .split("=")[1]
        ?.replace(/"/g, "") ?? "";
  } catch {
    /* os-release unreadable is non-fatal */
  }
  return {
    hostname: os.hostname(),
    uptime: os.uptime(),
    load: os.loadavg(),
    cores: os.cpus().length,
    memTotal: os.totalmem(),
    memUsed: os.totalmem() - os.freemem(),
    disk,
    osName,
    kernel: os.release(),
  };
}

export type StationSession = {
  jobId: string;
  stationId: string;
  role: string;
  sessionId: string | null;
  delivered: boolean;
};

// Reads the crew's job-card files directly (no seed imports: this app is
// copied standalone into the VM by the wizard). Malformed cards are skipped.
async function stationSessions(): Promise<StationSession[]> {
  const { readdir } = await import("node:fs/promises");
  const jobs = await readdir(join(DATA_DIR, "jobs")).catch(() => [] as string[]);
  const out: StationSession[] = [];
  for (const jobId of jobs) {
    const dir = join(DATA_DIR, "jobs", jobId);
    const names = await readdir(dir).catch(() => [] as string[]);
    const delivered = new Set(
      names
        .filter((n) => n.endsWith(".delivery.json"))
        .map((n) => n.replace(/\.delivery\.json$/, "")),
    );
    for (const name of names.filter((n) => n.endsWith(".card.json"))) {
      const cardId = name.replace(/\.card\.json$/, "");
      let role = "unknown";
      try {
        const raw: unknown = await Bun.file(join(dir, name)).json();
        if (raw && typeof raw === "object" && "role" in raw && typeof raw.role === "string")
          role = raw.role;
      } catch {
        /* malformed card: still list the station */
      }
      const session = (
        await Bun.file(join(dir, `${cardId}.session`))
          .text()
          .catch(() => "")
      ).trim();
      out.push({
        jobId,
        stationId: cardId,
        role,
        sessionId: session || null,
        delivered: delivered.has(cardId),
      });
    }
  }
  return out;
}

async function stateJson() {
  const units = await Promise.all((await listUnits()).map(unitState));
  const binaries: Record<string, string | null> = {};
  for (const [name, candidates] of Object.entries(BINARY_CANDIDATES)) {
    binaries[name] = null;
    for (const p of candidates)
      if (p && (await Bun.file(p).exists())) {
        binaries[name] = p;
        break;
      }
  }
  let processes: ReturnType<typeof parseProcesses> = [];
  let sessions: MuseSession[] = [];
  try {
    processes = parseProcesses(
      (
        await run(
          PS_BIN,
          [
            "-eo",
            "pid=,pcpu=,pmem=,comm=",
            "--sort=-pcpu",
          ],
          {
            timeout: 5000,
          },
        )
      ).stdout,
    );
  } catch {
    /* ps unreadable is non-fatal */
  }
  try {
    sessions = parseClaudeSessions(
      (
        await run(
          PS_BIN,
          [
            "-eo",
            "pid=,etime=,args=",
          ],
          {
            timeout: 5000,
          },
        )
      ).stdout,
    );
  } catch {
    /* ps unreadable is non-fatal */
  }
  let ports: ReturnType<typeof parsePorts> = [];
  try {
    ports = parsePorts(
      (
        await run(
          SS_BIN,
          [
            "-tlnpH",
          ],
          {
            timeout: 5000,
          },
        )
      ).stdout,
    );
  } catch {
    /* ss unreadable is non-fatal */
  }
  const state = {
    ok:
      failuresFor({
        units,
      }).length === 0,
    host: {
      label: os.hostname(),
    },
    units,
    binaries,
    vitals: await vitals(),
    processes,
    sessions,
    stations: await stationSessions(),
    ports,
    now: new Date().toISOString(),
  };
  return {
    ...state,
    failures: failuresFor(state),
  };
}

const isLoopback = BIND === "127.0.0.1" || BIND === "localhost" || BIND === "::1";

async function terminalExec(req: Request): Promise<Response> {
  if (!AUTH_PASS_HASH && !isLoopback) {
    return Response.json(
      {
        error: "terminal disabled: set STATUS_AUTH_PASS_HASH or bind loopback",
      },
      {
        status: 403,
      },
    );
  }
  if (
    AUTH_PASS_HASH &&
    !(await basicAuthOk(req.headers.get("authorization"), AUTH_USER, AUTH_PASS_HASH))
  ) {
    return new Response("unauthorized", {
      status: 401,
      headers: {
        "www-authenticate": 'Basic realm="factory-status"',
      },
    });
  }
  const body = (await req.json().catch(() => null)) as {
    command?: unknown;
  } | null;
  if (!body || typeof body.command !== "string" || !body.command.trim()) {
    return Response.json(
      {
        error: "command required",
      },
      {
        status: 400,
      },
    );
  }
  const proc = Bun.spawn(
    [
      "bash",
      "-lc",
      body.command,
    ],
    {
      cwd: TERMINAL_CWD,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  const timer = setTimeout(() => proc.kill(), 30_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const output = (stdout + stderr).slice(0, 64_000);
  return Response.json({
    code,
    output,
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: BIND,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/state") return Response.json(await stateJson());
    if (url.pathname === "/api/terminal/exec" && req.method === "POST") return terminalExec(req);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await Bun.file(join(import.meta.dir, "index.html"))
        .text()
        .catch(() => "");
      if (html)
        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        });
    }
    return new Response("not found", {
      status: 404,
    });
  },
});

console.log(`factory status listening on http://${BIND}:${server.port} (data ${DATA_DIR})`);
