// Deterministic stub crewmate for the recorded feature-creation run: one
// process per station, speaking the same JSONL a real `muse exec` session
// speaks (session event, text deltas, terminal completion), so the control
// room's live log tail reads exactly like a live run. Behaviour keys off the
// prompt phrases the pipeline really sends — the same contract the
// dispatch.test stubs use — plus the card ROLE for the builder fallback.
//
// Scripted to tell one honest story: triage -> planner -> two red-teams ->
// build -> a coder review that bounces the work once for weak coverage ->
// rework -> both reviewers pass -> verify runs green -> retro. The rejection
// is on purpose: the recording should show the review loop doing its job,
// not a suspiciously smooth run.
import { existsSync } from "node:fs";
import { join } from "node:path";

const prompt = process.argv.at(-1) ?? "";
const role = /ROLE (\w+)/.exec(prompt)?.[1] ?? "builder";
const wt = /Worktree \(your only cwd\): (\S+)/.exec(prompt)?.[1] ?? process.cwd();
const SID = "fea7u1e-4d0f-4c2e-8b11-c0ffee000001";

function event(payloadType: string, payload: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      stream: {
        kind: "session",
        id: SID,
      },
      payload_type: payloadType,
      payload,
    }),
  );
}

function delta(text: string): void {
  event("run.output.delta", {
    text,
  });
}

async function think(ms: number, text: string): Promise<void> {
  await Bun.sleep(ms);
  delta(text);
}

function done(text: string): void {
  event("run.terminal.completed", {
    text,
  });
}

const HELLO_SERVICE = [
  "// Hello route handler: the greeting the work order asked for.",
  'exports.hello = () => "hello from the factory";',
  "",
].join("\n");

// Attempt one ships a smoke check that is too weak to mean anything: it
// accepts any string, so verify passes but the plan's success criteria
// (pin the response body) are not met. The coder reviewer bounces it.
const HELLO_TEST_WEAK = [
  'const { hello } = require("./hello.js");',
  'if (typeof hello() !== "string") {',
  '  console.error("smoke check failed: no payload");',
  "  process.exit(1);",
  "}",
  'console.log("smoke check passed: the route returns a payload");',
  "",
].join("\n");

// The rework after the rejection pins the exact greeting.
const HELLO_TEST_STRONG = [
  'const { hello } = require("./hello.js");',
  'if (hello() !== "hello from the factory") {',
  '  console.error("smoke check failed: unexpected payload");',
  "  process.exit(1);",
  "}",
  'console.log("smoke check passed: hello returns the greeting");',
  "",
].join("\n");

const PLAN_DRAFT = [
  "# Intent",
  "Add a hello service and expose it at /hello on the existing server.",
  "",
  "## Why",
  "The work order names a public greeting route; the demo site needs it to",
  "show the factory end to end.",
  "",
  "## Approach",
  "One route module (hello.js) exporting the handler, one smoke check",
  "(hello.test.js) pinning the response body, both wired into the server.",
  "Small steps, no new dependencies.",
  "",
  "## Success criteria",
  "`npm run verify` passes: the smoke check asserts the route returns the",
  "greeting. A reviewer confirms the diff stays inside the task.",
  "",
].join("\n");

const STATUS_PLAN = [
  "# Intent",
  "Add a status page at /status showing service health as JSON and HTML, with tests.",
  "",
  "## Why",
  "Operators need one URL that proves the service is up, in a form humans and monitors both read.",
  "",
  "## Approach",
  "1. status.js exporting statusJson() and statusPage() (server.js already routes /status to it when present).",
  "2. status.test.js pinning the JSON payload and the page headline.",
  "3. visual.moments.json declaring the screenshot moment for Visual Review.",
  "Small steps, no new dependencies.",
  "",
  "## Success criteria",
  "`npm run verify` passes with the status test pinning { up: true } and the page headline; the /status screenshot matches the declared moment.",
  "",
  "## Visual moments",
  "- status-page: /status",
  "",
].join("\n");

const STATUS_JS = [
  "// Status endpoint payloads: JSON for monitors, HTML for humans.",
  'exports.statusJson = () => ({ up: true, service: "demo", status: "ok" });',
  "exports.statusPage = () => '<!doctype html><title>Service status</title><main><h1>Service status</h1><p>status: ok</p><p>All checks passing.</p></main>';",
  "",
].join("\n");

const STATUS_TEST_WEAK = [
  'const { statusPage } = require("./status.js");',
  'if (typeof statusPage() !== "string") { console.error("status check failed"); process.exit(1); }',
  'console.log("status check passed: page renders");',
  "",
].join("\n");

const STATUS_TEST_STRONG = [
  'const { statusJson, statusPage } = require("./status.js");',
  'if (statusJson().up !== true || statusJson().status !== "ok") { console.error("status check failed: payload"); process.exit(1); }',
  'if (!statusPage().includes("Service status") || !statusPage().includes("status: ok")) { console.error("status check failed: page"); process.exit(1); }',
  'console.log("status check passed: payload and page pinned");',
  "",
].join("\n");

const STATUS_MOMENTS =
  JSON.stringify(
    [
      {
        name: "status-page",
        route: "/status",
        viewport: "1280x720",
        actions: [],
      },
    ],
    null,
    2,
  ) + "\n";

interface Handler {
  test: (p: string) => boolean;
  run: () => Promise<string>;
}

const HANDLERS: Handler[] = [
  {
    test: (p) => p.includes("Triage this task before anyone plans it"),
    run: async () => {
      await think(120, "Sizing the work order…\n");
      await think(
        200,
        "One service, one route, one smoke check — but the route is public, so behaviour changes and a regression check matters.\n",
      );
      return (
        "TRIAGE lane=standard size=S redteams=2 risks=public-endpoint est=8\n" +
        "Two red-teams: the route is public and a regression check is cheap to add."
      );
    },
  },
  {
    test: (p) => p.includes("Write the implementation plan"),
    run: async () => {
      await think(150, "Reading the work order and project history…\n");
      await think(
        220,
        "Drafting approach: one route module, one smoke check, wired into the existing server.\n",
      );
      await Bun.write(
        join(wt, "PLAN-DRAFT.md"),
        prompt.includes("/status") ? STATUS_PLAN : PLAN_DRAFT,
      );
      return "PLAN_WRITTEN";
    },
  },
  {
    test: (p) => p.includes("Red-team this plan as a subject-matter expert"),
    run: async () => {
      await think(160, "Checking intent against the codebase…\n");
      await think(
        140,
        "The route is public; the check must pin the response body, not just the status line.\n",
      );
      return [
        "PASS sme plan ok",
        "Argument: intent is narrow enough to test in one file",
        "Argument: approach reuses the existing service layout",
        "Argument: success criteria name a concrete check",
      ].join("\n");
    },
  },
  {
    test: (p) => p.includes("Red-team this plan as an outside reviewer"),
    run: async () => {
      await think(150, "Questioning the premise before touching the plan…\n");
      return [
        "PASS outsider ok",
        "Argument: why-now holds, the work order names a real route",
        "Argument: no simpler solution was named",
      ].join("\n");
    },
  },
  {
    test: (p) => p.includes("Review as a code reviewer"),
    run: async () => {
      if (existsSync(join(wt, ".coder-rejected"))) {
        await think(140, "Re-checking the diff after the rework…\n");
        return [
          "PASS coder ok",
          "Argument: the smoke check now pins the exact greeting",
          "Argument: diff stays inside the task",
        ].join("\n");
      }
      await think(180, "Reading the diff against the plan…\n");
      await think(
        160,
        "The smoke check accepts any string, so it cannot catch a regression in the payload — the plan's success criteria pin the body.\n",
      );
      await Bun.write(join(wt, ".coder-rejected"), "1");
      return [
        "REJECT weak coverage",
        "Argument: the smoke check accepts any string, not the greeting the work order asks for",
        "Argument: the plan's success criteria pin the response body",
      ].join("\n");
    },
  },
  {
    test: (p) => p.includes("Review as a subject-matter expert"),
    run: async () => {
      await think(140, "Judging the diff against the work order…\n");
      return [
        "PASS sme ok",
        "Intent as I understand it: ship the public hello route",
        "Argument: diff matches the plan",
      ].join("\n");
    },
  },
  {
    test: (p) => p.includes("Write the retrospective"),
    run: async () => {
      await think(150, "Writing the shift log…\n");
      return [
        "RETRO_DONE",
        "One coder review bounced the first attempt for missing coverage; the rework converged on attempt two.",
        "FINDING: extract the route smoke check into a shared health script",
      ].join("\n");
    },
  },
  {
    test: (p) => p.includes("is not runnable") || p.includes("not a real check"),
    run: async () => {
      await think(120, "Checking how this project is verified…\n");
      return "found how this project is verified\nVERIFY: true";
    },
  },
];

for (const handler of HANDLERS) {
  if (!handler.test(prompt)) continue;
  done(await handler.run());
  process.exit(0);
}

// Fallback: the builder's two attempts. Attempt one ships the service with
// a smoke check that passes but is too weak to mean anything (the coder
// reviewer bounces it); attempt two pins the exact greeting after the
// rejection, which is what makes the reviewer pass.
if (role === "builder" && prompt.includes("/status")) {
  await Bun.write(join(wt, "status.js"), STATUS_JS);
  await Bun.write(join(wt, "visual.moments.json"), STATUS_MOMENTS);
  if (existsSync(join(wt, ".coder-rejected"))) {
    await think(150, "Reworking per review: pinning the status payload and page headline…\n");
    await Bun.write(join(wt, "status.test.js"), STATUS_TEST_STRONG);
    await Bun.write(join(wt, "verification.webm"), "recording-placeholder");
    done("pinned the status payload and page; verify green");
    process.exit(0);
  }
  await think(150, "Building the status page: status.js, its test, and the visual moment…\n");
  await Bun.write(join(wt, "status.test.js"), STATUS_TEST_WEAK);
  done("built the status page with a smoke check (verify green)");
  process.exit(0);
}

if (role === "builder") {
  if (existsSync(join(wt, ".coder-rejected"))) {
    await think(150, "Reworking per review: pinning the greeting in the smoke check…\n");
    await Bun.write(join(wt, "hello.js"), HELLO_SERVICE);
    await Bun.write(join(wt, "hello.test.js"), HELLO_TEST_STRONG);
    await Bun.write(join(wt, "verification.webm"), "recording-placeholder");
    await think(120, "Verify still green.\n");
    done("hardened the smoke check to pin the greeting; verify green");
    process.exit(0);
  }
  await think(150, "Reading the work order and inspecting the worktree…\n");
  await think(200, "Writing the hello service…\n");
  await Bun.write(join(wt, "hello.js"), HELLO_SERVICE);
  await Bun.write(join(wt, "hello.test.js"), HELLO_TEST_WEAK);
  await think(120, "hello.js written, smoke check in place.\n");
  done("built the hello service with a smoke check (verify green)");
  process.exit(0);
}

done(`station ${role} finished`);
