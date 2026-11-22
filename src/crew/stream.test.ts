import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lastStationLine,
  runStation,
  type StationOutput,
  stationOutput,
  watchStation,
} from "./orchestrator";
import { describeMuseLine, MuseJsonlParser } from "./preset";
import { FactoryStore } from "./store";

const SESSION = "01a162dc-682c-79b3-a827-8fb6562bb4d8";
const jsonl = (payloadType: string, payload: Record<string, unknown>) =>
  JSON.stringify({
    stream: {
      kind: "session",
      id: SESSION,
    },
    payload_type: payloadType,
    payload,
  });

describe("MuseJsonlParser (incremental live-log parser)", () => {
  test("handles lines split across chunk boundaries", () => {
    const p = new MuseJsonlParser();
    const full =
      jsonl("run.terminal.completed", {
        text: "final answer",
      }) + "\n";
    const cut = Math.floor(full.length / 2);
    const out = [
      ...p.feed(full.slice(0, cut)),
      ...p.feed(full.slice(cut)),
      ...p.flush(),
    ];
    expect(out).toContain("final answer");
    expect(p.sessionId).toBe(SESSION);
    expect(p.completed).toBe(true);
  });

  test("delta text accumulates and flushes on newline, not per token", () => {
    const p = new MuseJsonlParser();
    expect(
      p.feed(
        jsonl("run.output.delta", {
          text: "working ",
        }) + "\n",
      ),
    ).toEqual([]); // buffered, no spam
    expect(
      p.feed(
        jsonl("run.output.delta", {
          text: "hard…\n",
        }) + "\n",
      ),
    ).toEqual([
      "working hard…",
    ]);
    expect(
      p.feed(
        jsonl("run.terminal.completed", {
          text: "done",
        }) + "\n",
      ),
    ).toEqual([
      "done",
    ]);
    expect(p.reply).toBe("working hard…\ndone");
  });

  test("long delta streams flush by size so a thinking agent stays alive", () => {
    const p = new MuseJsonlParser();
    const long = "x".repeat(200);
    const out = p.feed(
      jsonl("run.output.delta", {
        text: long,
      }) + "\n",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(long);
  });

  test("non-JSON lines pass through unchanged", () => {
    const p = new MuseJsonlParser();
    expect(p.feed("plain banner\n")).toEqual([
      "plain banner",
    ]);
  });

  test("tool events become labelled lines, not raw JSON", () => {
    const p = new MuseJsonlParser();
    const out = p.feed(
      jsonl("run.tool.updated", {
        name: "Edit",
        text: "editing nginx.conf",
      }) + "\n",
    );
    expect(out.join("")).toContain("[Edit: editing nginx.conf]");
  });

  test("flush drains a partial trailing line and pending deltas", () => {
    const p = new MuseJsonlParser();
    const line = jsonl("run.output.delta", {
      text: "almost ",
    });
    expect(p.feed(line.slice(0, 10))).toEqual([]); // mid-JSON: carried until the newline
    expect(p.feed(`${line.slice(10)}\n`)).toEqual([]); // parsed, but a short delta stays pending
    expect(p.flush()).toEqual([
      "almost ",
    ]); // flush drains it — never a blank
    expect(p.feed("plain tail without newline")).toEqual([]);
    expect(p.flush()).toEqual([
      "plain tail without newline",
    ]); // raw pass-through
  });

  test("describeMuseLine returns null for non-JSON", () => {
    expect(describeMuseLine("not json at all")).toBeNull();
  });
});

describe("station live output (control room buffer)", () => {
  test("watchStation streams parsed lines while the station runs, then done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-stream-"));
    const store = new FactoryStore(dir);
    const stub = join(dir, "stub.ts");
    await Bun.write(
      stub,
      [
        `const SID = "${SESSION}";`,
        `const ev = (t: string, p: unknown) => console.log(JSON.stringify({ stream: { kind: "session", id: SID }, payload_type: t, payload: p }));`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: SID } }));`,
        `ev("run.output.delta", { text: "reading…\\n" });`,
        `await Bun.sleep(120);`,
        `ev("run.output.delta", { text: "editing\\n" });`,
        `console.error("a warning line");`,
        `await Bun.sleep(120);`,
        `ev("run.terminal.completed", { text: "shipped" });`,
      ].join("\n"),
    );
    const card = {
      id: "s1",
      jobId: "j1",
      role: "builder" as const,
      task: "add hello service",
      worktree: dir,
      constraints: [],
      gates: [],
    };
    await store.writeCard(card);

    const seen: string[] = [];
    let deliveredOut: StationOutput | null = null;
    watchStation("s1", (out) => {
      deliveredOut = out;
      out.subscribeParsed((l) => seen.push(l.text));
    });
    const note = await runStation(card, {
      store,
      command: [
        "bun",
        stub,
      ],
      timeoutMs: 10_000,
    });

    expect(note.status).toBe("done");
    expect(note.summary).toContain("shipped");
    expect(seen).toContain("reading…");
    expect(seen).toContain("editing");
    expect(seen.some((l) => l.includes("[stderr] a warning line"))).toBe(true);
    expect(seen.some((l) => l.includes("[session"))).toBe(true);
    const out = stationOutput("s1");
    expect(out).not.toBeNull();
    if (!out) throw new Error("station output missing");
    expect(out.done).toBe(true);
    // The pre-spawn watcher must have received the very same object.
    expect(deliveredOut === out).toBe(true);
    expect(lastStationLine("s1")).toBe("shipped");
  });

  test("replay covers late viewers; seq resume skips what they already have", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-stream-"));
    const store = new FactoryStore(dir);
    const stub = join(dir, "stub.ts");
    await Bun.write(
      stub,
      [
        `const SID = "${SESSION}";`,
        `const ev = (t: string, p: unknown) => console.log(JSON.stringify({ stream: { kind: "session", id: SID }, payload_type: t, payload: p }));`,
        `for (let i = 1; i <= 5; i++) ev("run.output.delta", { text: "step " + i + "\\n" });`,
        `ev("run.terminal.completed", { text: "finished" });`,
      ].join("\n"),
    );
    const card = {
      id: "s2",
      jobId: "j2",
      role: "builder" as const,
      task: "steps",
      worktree: dir,
      constraints: [],
      gates: [],
    };
    await store.writeCard(card);
    await runStation(card, {
      store,
      command: [
        "bun",
        stub,
      ],
      timeoutMs: 10_000,
    });

    const out = stationOutput("s2");
    expect(out?.done).toBe(true);
    const all = out?.replayParsed(-1) ?? [];
    expect(all.map((l) => l.text)).toEqual([
      "step 1",
      "step 2",
      "step 3",
      "step 4",
      "step 5",
      "finished",
    ]);
    // A viewer that already saw seq 2 gets only the remainder.
    const tail = out?.replayParsed(all[2]?.seq ?? -1) ?? [];
    expect(tail.map((l) => l.text)).toEqual([
      "step 4",
      "step 5",
      "finished",
    ]);
    // Raw replay reports its byte window.
    const raw = out?.replayRaw(0) ?? {
      text: "",
      end: 0,
    };
    expect(raw.text).toContain("run.output.delta");
    expect(raw.end).toBe(raw.text.length);
  }, 15_000);
});
