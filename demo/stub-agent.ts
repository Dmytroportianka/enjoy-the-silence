// Deterministic stub crewmate for the offline demo rehearsal. A separate
// process per station, same job-card contract as a real `muse exec` station.
// Behaviour is keyed by ROLE in the prompt; the live demo swaps this command
// for the Muse preset (see run-demo.ts --live).
//
// Output streams like real muse: a session event first, text deltas as the
// station "works" (small sleeps keep the rehearsal readable), then the final
// answer as run.terminal.completed. The orchestrator's live log parses this
// the same way it parses real muse JSONL.
import { join } from "node:path";

const prompt = process.argv.at(-1) ?? "";
const role = /ROLE (\w+)/.exec(prompt)?.[1] ?? "builder";
const wt = /Worktree \(your only cwd\): (\S+)/.exec(prompt)?.[1] ?? process.cwd();
const conf = join(wt, "nginx.conf");
const SID = "01a162dc-682c-79b3-a827-8fb6562bb4d8";
function event(payloadType: string, payload: Record<string, unknown>) {
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
function delta(text: string) {
  event("run.output.delta", {
    text,
  });
}
async function think(ms: number, text: string) {
  await Bun.sleep(ms);
  delta(text);
}
function done(text: string) {
  event("run.terminal.completed", {
    text,
  });
}

if (role === "builder") {
  await think(150, "Reading the work order and inspecting the worktree…\n");
  await think(250, "Adding the hello service…\n");
  // Planted fault: missing semicolon after listen.
  await Bun.write(conf, "server {\n  listen 8080\n  location /hello { return 200 'hello'; }\n}\n");
  await think(150, "nginx.conf written.\n");
  done("built hello service (nginx.conf written)");
} else if (role === "qc") {
  await think(150, "Verifying the delivery against the work order…\n");
  const text = await Bun.file(conf)
    .text()
    .catch(() => "");
  if (!/listen 8080;/.test(text)) {
    await think(250, "nginx.conf does not parse — inspecting line 2…\n");
    done("QC FAIL: missing semicolon after listen 8080");
    process.exit(1);
  }
  await think(150, "Config parses, hello route present.\n");
  done("QC PASS: nginx.conf valid");
} else if (role === "fixer") {
  await think(150, "Patching nginx.conf…\n");
  const text = await Bun.file(conf)
    .text()
    .catch(() => "");
  await Bun.write(conf, text.replace("listen 8080\n", "listen 8080;\n"));
  await think(150, "Semicolon added.\n");
  done("fixed missing semicolon");
} else {
  done(`role ${role} done`);
}
