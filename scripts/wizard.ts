#!/usr/bin/env bun
// enjoy-the-silence wizard: generates (never applies) a starter environment.
//   bun run wizard                      interactive prompts
//   bun run wizard -- --target incus --brain muse --out ./my-env
//   bun run wizard -- --target clean --special "add tailscale" --out ./my-env
// --special hands the special cases to a Muse builder session plus a
// separate QC session (see src/scaffold.ts); without it the wizard is
// purely deterministic. The wizard generates only — it never applies.
// Targets: incus (throwaway demo box) | existing (module for your NixOS)
//          | clean (full config for dedicated hardware)
//          | cloud (OpenTofu for Hetzner/DigitalOcean; generation only).
// The generated README always builds before switching; so should you.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { MUSE_PRESET, parseMuseOutput } from "../src/crew/preset";
import { type AgentRunner, QcVetoError, scaffoldWithAgent } from "../src/scaffold";
import {
  BRAINS,
  CLOUD_PROVIDERS,
  DEFAULT_ANSWERS,
  ENTRIES,
  generateWizardFiles,
  TARGETS,
  type WizardAnswers,
} from "../src/wizard";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const nonInteractive = typeof args.target === "string";

let rl: ReturnType<typeof createInterface> | null = null;
let pipedLines: string[] | null = null;
let pipedIndex = 0;
async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped input: read it all up front (per-question readline drops lines).
    if (pipedLines === null) {
      pipedLines = (await Bun.stdin.text()).split("\n");
    }
    const answer = (pipedLines[pipedIndex++] ?? "").trim();
    console.log(`${question} [${fallback}]: ${answer}`);
    return answer || fallback;
  }
  rl ??= createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
  return answer || fallback;
}
function closeAsk(): void {
  rl?.close();
  rl = null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
async function collectAnswers(): Promise<{
  answers: WizardAnswers;
  specialCases: string;
}> {
  if (nonInteractive) {
    return {
      specialCases: typeof args.special === "string" ? args.special : "",
      answers: {
        target: (args.target as WizardAnswers["target"]) ?? DEFAULT_ANSWERS.target,
        hostname: (args.hostname as string) ?? DEFAULT_ANSWERS.hostname,
        username: (args.user as string) ?? DEFAULT_ANSWERS.username,
        brain: (args.brain as WizardAnswers["brain"]) ?? DEFAULT_ANSWERS.brain,
        entry: (args.entry as WizardAnswers["entry"]) ?? DEFAULT_ANSWERS.entry,
        statusPage: args["no-status-page"] !== true,
        updateCheck: args["no-update-check"] !== true,
        museBilling: (args.billing as WizardAnswers["museBilling"]) ?? DEFAULT_ANSWERS.museBilling,
        backgroundTasks: args["no-background"] !== true,
        cloudProvider:
          (args.provider as WizardAnswers["cloudProvider"]) ?? DEFAULT_ANSWERS.cloudProvider,
        cloudRegion: (args.region as string) ?? DEFAULT_ANSWERS.cloudRegion,
        cloudSize: (args.size as string) ?? DEFAULT_ANSWERS.cloudSize,
        gitea: args["no-gitea"] !== true,
        dashboard: args["no-dashboard"] !== true,
        mirrorRemote: (args.mirror as string) ?? DEFAULT_ANSWERS.mirrorRemote,
      },
    };
  }
  console.log("enjoy-the-silence wizard — generates files only; nothing is applied.\n");
  console.log(`Targets: ${TARGETS.join(" | ")}`);
  console.log(`Brains:  ${BRAINS.join(" | ")}   Entries: ${ENTRIES.join(" | ")}\n`);
  const a = {
    ...DEFAULT_ANSWERS,
  };
  a.target = (await ask("Run target", a.target)) as WizardAnswers["target"];
  a.hostname = await ask("Hostname", a.hostname);
  a.username = await ask("Username", a.username);
  a.brain = (await ask("Agent brain", a.brain)) as WizardAnswers["brain"];
  if (a.brain === "muse") {
    a.museBilling = (await ask(
      "Muse billing: api (per-token) or plan (login)",
      a.museBilling,
    )) as WizardAnswers["museBilling"];
  }
  a.backgroundTasks =
    (await ask("Background tasks / self-improvement without you? (y/n)", "y")).toLowerCase() !==
    "n";
  a.entry = (await ask("Entry point", a.entry)) as WizardAnswers["entry"];
  if (a.target === "cloud") {
    console.log(`Providers: ${CLOUD_PROVIDERS.join(" | ")}`);
    a.cloudProvider = (await ask(
      "Cloud provider",
      a.cloudProvider,
    )) as WizardAnswers["cloudProvider"];
    a.cloudRegion = await ask(
      "Cloud region (blank = provider default)",
      a.cloudRegion || "default",
    );
    if (a.cloudRegion === "default") a.cloudRegion = "";
    a.cloudSize = await ask("Cloud size (blank = provider default)", a.cloudSize || "default");
    if (a.cloudSize === "default") a.cloudSize = "";
  }
  a.statusPage = (await ask("Status page on :8123? (y/n)", "y")).toLowerCase() !== "n";
  a.updateCheck = (await ask("Update-check timer? (y/n)", "y")).toLowerCase() !== "n";
  const specialCases = await ask(
    "Special cases the templates do not cover? (blank = none, Muse scaffolds them)",
    "",
  );
  return {
    answers: a,
    specialCases,
  };
}

function makeRunner(cwd: string): AgentRunner {
  return async (prompt: string) => {
    const proc = Bun.spawn(
      [
        ...MUSE_PRESET.command,
        prompt,
      ],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    const timer = setTimeout(() => proc.kill(), 15 * 60_000);
    const [stdout, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0)
      throw new Error(`muse agent exited ${code} — is \`muse\` installed and logged in?`);
    return parseMuseOutput(stdout).reply;
  };
}

const { answers, specialCases } = await collectAnswers();
closeAsk();
const files = generateWizardFiles(answers); // throws on invalid answers
const outDir = (args.out as string) ?? "./enjoy-the-silence-generated";

if (existsSync(outDir) && args.force !== true) {
  console.error(`Output dir ${outDir} already exists (use --force to overwrite).`);
  process.exit(1);
}
await mkdir(outDir, {
  recursive: true,
});
if (answers.statusPage) {
  // The status app ships as real files in the seed, not generated strings:
  // copy it next to the generated config so run-incus.sh can push it in-VM.
  const statusSrc = join(import.meta.dir, "..", "status");
  await mkdir(join(outDir, "status"), {
    recursive: true,
  });
  for (const f of [
    "server.ts",
    "lib.ts",
    "index.html",
  ]) {
    await copyFile(join(statusSrc, f), join(outDir, "status", f));
    console.log(`wrote ${join(outDir, "status", f)} (status app)`);
  }
}
for (const [name, content] of files) {
  await writeFile(
    join(outDir, name),
    content,
    name.endsWith(".sh")
      ? {
          mode: 0o755,
        }
      : undefined,
  );
  console.log(`wrote ${join(outDir, name)}`);
}

if (specialCases.trim()) {
  console.log("\nSpecial cases: Muse builder scaffolds, separate QC session checks…");
  try {
    const result = await scaffoldWithAgent({
      answers,
      baseFiles: files,
      specialCases,
      runBuilder: makeRunner(outDir),
      runQc: makeRunner(outDir),
    });
    if (result) {
      for (const name of result.changed) {
        files.set(name, result.files.get(name) ?? "");
        await writeFile(
          join(outDir, name),
          result.files.get(name) ?? "",
          name.endsWith(".sh")
            ? {
                mode: 0o755,
              }
            : undefined,
        );
        console.log(`wrote ${join(outDir, name)} (agent)`);
      }
      console.log(`builder: ${result.builderSummary}`);
      console.log(`QC: ${result.qcSummary.split("\n")[0]}`);
    }
  } catch (err) {
    console.error(
      err instanceof QcVetoError
        ? err.message
        : `agent scaffolding FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error("Base files above are intact; no agent file was written.");
    process.exit(1);
  }
}

// Parse-check the generated .nix where nix is available; generation is valid
// either way, but a parse failure must be loud, not a surprise at switch time.
const nixFiles = [
  ...files.keys(),
].filter((f) => f.endsWith(".nix"));
let hasNix = true;
try {
  execSync("command -v nix-instantiate", {
    stdio: "ignore",
  });
} catch {
  hasNix = false;
}
if (!hasNix) {
  console.log("nix parse check: skipped (nix-instantiate not on PATH)");
} else {
  try {
    for (const f of nixFiles) {
      execSync(`nix-instantiate --parse ${join(outDir, f)}`, {
        stdio: "ignore",
      });
    }
    console.log(`nix parse check: ok (${nixFiles.join(", ")})`);
  } catch (err) {
    console.error(`nix parse check FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
console.log(`\nNext: cd ${outDir} && cat README.md — build before switching, always.`);
