// status/lib.ts — pure, testable helpers for the factory status server.
// Ported from the reference host/status lib; tmux panes are replaced by
// Muse subsessions. No I/O beyond what is passed in.

// HTTP Basic auth check against a bcrypt hash (Bun.password). Returns false
// when unconfigured, missing, malformed, or wrong — write paths fail closed.
export async function basicAuthOk(
  header: string | null,
  user: string,
  passHash: string,
): Promise<boolean> {
  if (!passHash || !header) return false;
  const m = /^Basic\s+(.+)$/i.exec(header);
  const encoded = m?.[1];
  if (!encoded) return false;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  if (decoded.slice(0, idx) !== user) return false;
  return Bun.password.verify(decoded.slice(idx + 1), passHash);
}

export type ProcessRow = {
  pid: number;
  cpu: number;
  mem: number;
  cmd: string;
};

// Parses `ps -eo pid=,pcpu=,pmem=,comm=` output into top-N rows.
export function parseProcesses(stdout: string, limit = 20): ProcessRow[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(/\s+/);
      if (parts.length < 4) return null;
      const pid = Number(parts[0]);
      const cpu = Number(parts[1]);
      const mem = Number(parts[2]);
      if (!Number.isFinite(pid) || !Number.isFinite(cpu) || !Number.isFinite(mem)) return null;
      return {
        pid,
        cpu,
        mem,
        cmd: parts.slice(3).join(" ").slice(0, 80),
      };
    })
    .filter((r): r is ProcessRow => r !== null)
    .slice(0, limit);
}

export type PortRow = {
  local: string;
  process: string;
};

// Parses `ss -tlnpH` output into { local, process } per LISTEN socket.
export function parsePorts(stdout: string): PortRow[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(/\s+/);
      const local = parts[3] ?? "";
      const rest = parts.slice(5).join(" ");
      const m = /users:\(\("([^"]+)"/.exec(rest);
      return {
        local,
        process: m?.[1] ?? "",
      };
    })
    .filter((p) => p.local.includes(":"));
}

export type MuseSession = {
  pid: number;
  etime: string;
  sessionId: string | null;
  resumed: boolean;
  command: string;
};

// Parses `ps -eo pid=,etime=,args=` output into running Muse subsessions:
// every `muse exec` process, with its --session-id when it is a resume.
// This replaces the reference's tmux-pane list — the factory has no tmux;
// its parallel work is separate muse processes in separate worktrees.
export function parseClaudeSessions(stdout: string): MuseSession[] {
  const out: MuseSession[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    const [, pidRaw, etime, args] = m ?? [];
    if (!pidRaw || !etime || !args) continue;
    if (!/\bmuse\b/.test(args) || !/\bexec\b/.test(args)) continue;
    const sid = /--session-id\s+(\S+)/.exec(args)?.[1] ?? null;
    out.push({
      pid: Number(pidRaw),
      etime,
      sessionId: sid,
      resumed: sid !== null,
      command: args.slice(0, 120),
    });
  }
  return out;
}

// Failure classification: a /state payload reduces to `kind|name` keys.
export type Failure = {
  kind: string;
  name: string;
};
export const failureKey = (f: Failure) => `${f.kind}|${f.name}`;

export function failuresFor(
  state: {
    units?: Array<{
      id: string;
      activeState: string;
    }>;
  } | null,
): Failure[] {
  if (!state)
    return [
      {
        kind: "host",
        name: "unreachable",
      },
    ];
  return (state.units ?? [])
    .filter((u) => u.activeState === "failed")
    .map((u) => ({
      kind: "unit",
      name: u.id,
    }));
}
