import { useEffect, useState } from "react";
import { Surface } from "./Surface";

interface Line {
  text: string;
  delay: number;
  kind?: "prompt" | "input" | "output" | "success";
}

const SCRIPT: Line[] = [
  {
    text: "$ bun scripts/wizard.ts",
    delay: 300,
    kind: "prompt",
  },
  {
    text: "",
    delay: 400,
  },
  {
    text: "? Target (incus/existing/clean/cloud): incus",
    delay: 900,
    kind: "input",
  },
  {
    text: "? Hostname: agent-os-demo",
    delay: 900,
    kind: "input",
  },
  {
    text: "? Username: agent",
    delay: 900,
    kind: "input",
  },
  {
    text: "? Brain (muse/claude-code/opencode/hermes): muse",
    delay: 900,
    kind: "input",
  },
  {
    text: "? Entry (cli): cli",
    delay: 900,
    kind: "input",
  },
  {
    text: "? Status page: yes",
    delay: 700,
    kind: "input",
  },
  {
    text: "? Gitea: yes",
    delay: 700,
    kind: "input",
  },
  {
    text: "? Dashboard: yes",
    delay: 700,
    kind: "input",
  },
  {
    text: "",
    delay: 500,
  },
  {
    text: "Generating NixOS configuration…",
    delay: 1200,
    kind: "output",
  },
  {
    text: "  ✓ /etc/nixos/configuration.nix",
    delay: 600,
    kind: "success",
  },
  {
    text: "  ✓ /etc/nixos/hardware-configuration.nix",
    delay: 600,
    kind: "success",
  },
  {
    text: "  ✓ factory-data/settings.json",
    delay: 600,
    kind: "success",
  },
  {
    text: "  ✓ README.md (builds before any switch)",
    delay: 600,
    kind: "success",
  },
  {
    text: "",
    delay: 500,
  },
  {
    text: "Next: review the generated files, then:",
    delay: 800,
    kind: "output",
  },
  {
    text: "  nixos-rebuild switch",
    delay: 600,
    kind: "prompt",
  },
  {
    text: "",
    delay: 400,
  },
  {
    text: "Done. The factory is configured; boot it to start Gitea, the dashboard, and the worktree pool.",
    delay: 1000,
    kind: "success",
  },
];

export function WizardDemo() {
  const [lines, setLines] = useState<
    {
      text: string;
      kind?: string;
    }[]
  >([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let acc = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    SCRIPT.forEach((l, i) => {
      acc += l.delay;
      const t = setTimeout(() => {
        if (cancelled) return;
        setLines((prev) => [
          ...prev,
          {
            text: l.text,
            kind: l.kind,
          },
        ]);
        if (i === SCRIPT.length - 1) setDone(true);
      }, acc);
      timers.push(t);
    });
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <h2>Wizard — generate the factory</h2>
      <p className="text-muted">
        The wizard asks a few questions and writes a reproducible NixOS configuration. Nothing is
        applied until you review it and run <code>nixos-rebuild switch</code>.
      </p>
      <Surface surface="elevated" className="border p-4">
        <div
          id="tour-terminal"
          className="bg-black text-green-400 font-mono text-sm p-4 rounded min-h-[320px] whitespace-pre-wrap"
        >
          {lines.map((l, i) => (
            <div
              key={i}
              className={
                l.kind === "prompt" ? "text-cyan-300" : l.kind === "success" ? "text-green-300" : ""
              }
            >
              {l.text}
            </div>
          ))}
          {!done && <span className="animate-pulse">▌</span>}
        </div>
      </Surface>
      {done && (
        <p className="text-muted">
          Generated files are written to the target folder; the README builds before any switch.
        </p>
      )}
    </div>
  );
}
