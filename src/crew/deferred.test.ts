import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deferredQuestion,
  includedDeferredIds,
  newDeferredPoint,
  parseRedteamPoints,
  relatedDeferred,
} from "./deferred";
import { FactoryStore } from "./store";
import { newTask } from "./task";

const AT = "2026-11-02T10:00:00.000Z";
const point = (text: string, id = "d1") =>
  newDeferredPoint({
    id,
    projectId: "p1",
    sourceTaskId: "t0",
    sourceTitle: "Add hello",
    text,
    tags: [
      "ui",
    ],
    at: AT,
  });

describe("parseRedteamPoints", () => {
  test("tagged MINOR/MAJOR points split by severity", () => {
    const { majors, minors } = parseRedteamPoints(
      "REJECT\n- MINOR: add a loading spinner\n- MAJOR: no auth check on the endpoint",
      "reject",
    );
    expect(majors).toEqual([
      "no auth check on the endpoint",
    ]);
    expect(minors).toEqual([
      "add a loading spinner",
    ]);
  });
  test("untagged points on a REJECT count as MAJOR (deferral must be explicit)", () => {
    const { majors, minors } = parseRedteamPoints(
      "REJECT\n- the plan ignores rate limiting",
      "reject",
    );
    expect(majors).toEqual([
      "the plan ignores rate limiting",
    ]);
    expect(minors).toEqual([]);
  });
  test("on a PASS, untagged prose is not a point, tagged minors still count", () => {
    const { majors, minors } = parseRedteamPoints(
      "PASS\nLooks sound overall.\n- MINOR: rename the helper for clarity",
      "pass",
    );
    expect(majors).toEqual([]);
    expect(minors).toEqual([
      "rename the helper for clarity",
    ]);
  });
});

describe("relatedDeferred + question + markers", () => {
  test("matches on shared keywords, ignores dismissed/included and the source task itself", () => {
    const task = newTask(
      {
        id: "t9",
        projectId: "p1",
        title: "Checkout spinner",
        prompt: "add a loading spinner to the checkout page",
      },
      AT,
    );
    const related = relatedDeferred(
      [
        point("add a loading spinner to checkout"),
        {
          ...point("unrelated database migration tuning", "d2"),
        },
      ],
      task,
    );
    expect(related.map((d) => d.id)).toEqual([
      "d1",
    ]);
    expect(
      relatedDeferred(
        [
          {
            ...point("add a loading spinner to checkout"),
            status: "dismissed",
          },
        ],
        task,
      ),
    ).toEqual([]);
  });
  test("question carries the marker, and a plan carrying it reads as included", () => {
    const q = deferredQuestion(point("add a loading spinner"));
    expect(q).toContain("[deferred:d1]");
    expect(includedDeferredIds(`## Deferred points included\n- [deferred:d1] add spinner`)).toEqual(
      [
        "d1",
      ],
    );
    expect(includedDeferredIds("no markers")).toEqual([]);
  });
});

describe("store deferred pool", () => {
  test("adds deduped by text, dismiss and include persist", async () => {
    const store = new FactoryStore(mkdtempSync(join(tmpdir(), "deferred-")));
    const added = await store.addDeferred("p1", [
      point("add a loading spinner"),
      point("Add a loading spinner!"),
    ]);
    expect(added).toHaveLength(1);
    expect(
      await store.addDeferred("p1", [
        point("add a loading spinner"),
      ]),
    ).toHaveLength(0);
    await store.setDeferredStatus("p1", "d1", "included", "t9");
    const listed = await store.listDeferred("p1");
    expect(listed[0]?.status).toBe("included");
    expect(listed[0]?.includedInTaskId).toBe("t9");
  });
});
