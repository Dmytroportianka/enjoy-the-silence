import { describe, expect, test } from "bun:test";
import {
  addedContentHits,
  formatContentReport,
  isUiPath,
  scanCopyLine,
  scanElement,
  visibleText,
} from "./content-scan";

const DIFF = (path: string, body: string) =>
  [
    `diff --git a/${path} b/${path}`,
    "--- a/x",
    `+++ b/${path}`,
    "@@ -1,0 +1,20 @@",
    ...body.split("\n").map((l) => `+${l}`),
  ].join("\n");

describe("scanElement — Band A is provable", () => {
  test("an empty href is dead unless the element handles the click", () => {
    expect(scanElement('<a href="#">Apply</a>')?.[0]?.kind).toBe("dead-control");
    expect(scanElement('<a href="" className="link">Apply</a>')?.[0]?.kind).toBe("dead-control");
    expect(scanElement('<a href="#" onClick={open}>Apply</a>')).toEqual([]);
  });

  test("an empty handler is dead", () => {
    expect(scanElement("<button onClick={() => {}}>Save</button>")?.[0]?.kind).toBe("dead-control");
    expect(scanElement("<button onClick={() => undefined}>Save</button>")?.[0]?.kind).toBe(
      "dead-control",
    );
    expect(scanElement("<button onClick={save}>Save</button>")).toEqual([]);
  });

  test("an anchor with no href and no handler is dead", () => {
    expect(scanElement('<a className="cta">Apply</a>')?.[0]?.kind).toBe("dead-control");
    expect(scanElement('<a className="cta" onClick={apply}>Apply</a>')).toEqual([]);
  });

  test("router links are judged by to=, not href=", () => {
    expect(scanElement('<Link to="#">Plans</Link>')?.[0]?.kind).toBe("dead-control");
    expect(scanElement('<Link to="/plans">Plans</Link>')).toEqual([]);
    expect(scanElement('<NavLink to="#">Plans</NavLink>')?.[0]?.kind).toBe("dead-control");
  });

  test("a hash target we cannot resolve is a candidate, not a veto", () => {
    const [hit] = scanElement('<a href="#pricing">Pricing</a>');
    expect(hit?.kind).toBe("ghost-link");
    expect(hit?.band).toBe("B");
  });
});

describe("dead-control bands — a missing handler is never proof on its own", () => {
  const NO_WIRING = {
    runtimeWiring: false,
  };

  test("the default is the safe band: a runtime-wired repo gets candidates", () => {
    const [hit] = scanElement('<a href="#">Apply</a>', "a.tsx", 1);
    expect(hit?.kind).toBe("dead-control");
    expect(hit?.band).toBe("B");
  });

  test("with no runtime wiring in the tree, the same line is provable", () => {
    const [hit] = scanElement('<a href="#">Apply</a>', "a.tsx", 1, NO_WIRING);
    expect(hit?.band).toBe("A");
  });

  test("an element offering a handle to wire stays a candidate", () => {
    // A script can reach these by id, ref, data attribute or a spread prop —
    // exactly how public/app.js wires `<button id="loop-prev">`.
    for (const source of [
      '<a id="loop-prev" href="#">Previous</a>',
      '<a ref={prevRef} href="#">Previous</a>',
      '<a data-action="prev" href="#">Previous</a>',
      '<a {...props} href="#">Previous</a>',
    ]) {
      expect(scanElement(source, "a.tsx", 1, NO_WIRING)[0]?.band).toBe("B");
    }
  });

  test("a candidate is never promoted by the context", () => {
    expect(scanElement("<button className={x}>Go</button>", "a.tsx", 1, NO_WIRING)[0]?.band).toBe(
      "B",
    );
    expect(scanElement('<a href="#pricing">P</a>', "a.tsx", 1, NO_WIRING)[0]?.band).toBe("B");
  });

  test("addedContentHits threads the context through", () => {
    const diff = DIFF("dashboard/src/App.tsx", '<a href="#">Apply</a>');
    expect(addedContentHits(diff)[0]?.band).toBe("B");
    expect(addedContentHits(diff, NO_WIRING)[0]?.band).toBe("A");
  });
});

describe("scanElement — Band B is a shortlist", () => {
  test("a button with no handler is a candidate", () => {
    const [hit] = scanElement("<button className={btnCls}>Go</button>");
    expect(hit?.kind).toBe("dead-candidate");
    expect(hit?.band).toBe("B");
  });

  test("submit, disabled and spread buttons are not candidates", () => {
    expect(scanElement('<button type="submit">Go</button>')).toEqual([]);
    expect(scanElement("<button disabled={busy}>Go</button>")).toEqual([]);
    expect(scanElement("<button {...rest}>Go</button>")).toEqual([]);
  });

  test("a role=button div with no handler is a candidate", () => {
    expect(scanElement('<div role="button">Go</div>')?.[0]?.kind).toBe("dead-candidate");
    expect(scanElement('<div role="button" onClick={go}>Go</div>')).toEqual([]);
  });

  test("elements the scanner does not judge produce nothing", () => {
    expect(scanElement('<img src="x.png">')).toEqual([]);
    expect(scanElement('<p className="lede">Copy</p>')).toEqual([]);
  });
});

describe("copy scanning", () => {
  test("a fabricated claim in visible copy is reported", () => {
    const [hit] = scanCopyLine("  <p>99.9% uptime, guaranteed</p>", "dashboard/src/App.tsx", 5);
    expect(hit?.kind).toBe("fake-claim");
    expect(hit?.band).toBe("B");
  });

  test("compliance and customer claims are reported", () => {
    expect(scanCopyLine("<p>SOC 2 compliant since day one</p>", "public/index.html")[0]?.kind).toBe(
      "fake-claim",
    );
    expect(
      scanCopyLine("<p>Trusted by ACME Corp and friends</p>", "public/index.html")[0]?.kind,
    ).toBe("fake-claim");
  });

  test("marketing filler is a buzzword", () => {
    expect(scanCopyLine('body: "seamless onboarding",', "public/app.js")[0]?.kind).toBe("buzzword");
    expect(
      scanCopyLine("<h2>Next-generation control room</h2>", "public/index.html")[0]?.kind,
    ).toBe("buzzword");
  });

  test("one line reports each kind once, not once per pattern", () => {
    const hits = scanCopyLine(
      "<h1>Seamless billing, trusted by 10K+ teams</h1>",
      "dashboard/src/App.tsx",
    );
    expect(hits.filter((h) => h.kind === "fake-claim").length).toBe(1);
    expect(hits.filter((h) => h.kind === "buzzword").length).toBe(1);
  });

  test("attribute values are not copy", () => {
    expect(scanCopyLine('<div className="seamless rounded-xl">x</div>', "a.tsx")).toEqual([]);
    expect(visibleText('<div className="seamless">x</div>')).not.toContain("seamless");
  });

  test("non-UI paths are never scanned for copy", () => {
    expect(scanCopyLine("// seamless retry loop", "src/crew/dispatch.ts")).toEqual([]);
    expect(scanCopyLine('expect(x).toBe("99.9% uptime")', "src/a.test.tsx")).toEqual([]);
  });

  test("isUiPath covers shipped UI and public assets, not tests or backend", () => {
    expect(isUiPath("dashboard/src/App.tsx")).toBe(true);
    expect(isUiPath("public/index.html")).toBe(true);
    expect(isUiPath("dashboard/src/App.test.tsx")).toBe(false);
    expect(isUiPath("src/crew/dispatch.ts")).toBe(false);
  });
});

describe("addedContentHits", () => {
  test("a formatted multi-line element is classified once", () => {
    const hits = addedContentHits(
      DIFF("dashboard/src/App.tsx", "<button\n  className={btnCls}\n>\n  Go\n</button>"),
    );
    expect(hits.filter((h) => h.kind === "dead-candidate").length).toBe(1);
    expect(hits.find((h) => h.kind === "dead-candidate")?.line).toBe(1);
  });

  test("an arrow handler does not close the tag early", () => {
    const hits = addedContentHits(
      DIFF(
        "dashboard/src/App.tsx",
        "<button\n  onClick={() => setOpen(!open)}\n>\n  Go\n</button>",
      ),
    );
    expect(hits).toEqual([]);
  });

  test("a disabled multi-line button is cleared across lines", () => {
    const hits = addedContentHits(
      DIFF(
        "dashboard/src/App.tsx",
        "<button\n  disabled={busy}\n  onClick={send}\n>\n  Go\n</button>",
      ),
    );
    expect(hits).toEqual([]);
  });

  test("an unclosed element never leaks into the next file", () => {
    const diff = [
      "diff --git a/a.tsx b/a.tsx",
      "--- a/a.tsx",
      "+++ b/a.tsx",
      "@@ -1,0 +1,2 @@",
      "+<button",
      "+  className={x}",
      "diff --git a/b.tsx b/b.tsx",
      "--- a/b.tsx",
      "+++ b/b.tsx",
      "@@ -1,0 +1,2 @@",
      '+<a href="#">x</a>',
    ].join("\n");
    const hits = addedContentHits(diff);
    expect(hits.length).toBe(1);
    expect(hits[0]?.file).toBe("b.tsx");
    expect(hits[0]?.kind).toBe("dead-control");
  });

  test("backend diffs carry no content findings", () => {
    expect(addedContentHits(DIFF("src/crew/store.ts", 'const msg = "99.9% uptime";'))).toEqual([]);
  });
});

describe("formatContentReport", () => {
  test("separates the bands so the reviewer knows what is provable", () => {
    const report = formatContentReport([
      {
        file: "a.tsx",
        line: 1,
        kind: "dead-control",
        band: "A",
        text: '<a href="#">x</a>',
      },
      {
        file: "a.tsx",
        line: 2,
        kind: "dead-candidate",
        band: "B",
        text: "<button>x</button>",
      },
    ]);
    expect(report).toContain(
      "1 Band A (no runtime wiring in this tree), 1 Band B (confirm by reading)",
    );
    expect(report).toContain("A a.tsx:1 dead-control");
    expect(report).toContain("B a.tsx:2 dead-candidate");
  });

  test("empty input reads as none", () => {
    expect(formatContentReport([])).toBe("(none)");
  });

  test("long input is capped and says how many it hid", () => {
    const hits = Array.from(
      {
        length: 4,
      },
      (_unused, i) => ({
        file: "a.tsx",
        line: i + 1,
        kind: "buzzword" as const,
        band: "B" as const,
        text: "seamless",
      }),
    );
    expect(formatContentReport(hits, 1)).toContain("... 3 more content finding(s)");
  });
});
