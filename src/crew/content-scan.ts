// Content scanner: the craft gate's deterministic half. Finds what a diff ADDS
// that is a defect rather than a taste call — fabricated claims, marketing
// filler, dead controls — and separates the two bands the review rules
// distinguish:
//
//   Band A  "provable without runtime wiring": the line has no target/handler,
//           AND this repo attaches no behaviour by other means, so nothing
//           outside the element can give it one. Only then may it back a
//           CRAFT-GATE veto.
//   Band B  a candidate: either the element may be legitimate (a submit button,
//           disabled, wired by a spread prop) or the repo does attach
//           behaviour at runtime — `getElementById(...).addEventListener`,
//           delegated `querySelectorAll("button")`, `.onclick =`, `ref`,
//           htmx/Alpine attributes — so reading the element proves nothing.
//           Reported as a shortlist; a reviewer confirms before it counts.
//
// Why Band A is defined this way, measured on our own tree: `public/index.html`
// ships `<button id="loop-prev">Previous</button>` with no handler, and
// `public/app.js` wires it with `addEventListener` at runtime. A "provable from
// the line" claim would have called that working button dead. Absence of a
// handler in the diff is never proof on its own; absence of every wiring
// mechanism in the repo is.
//
// Why the split exists, measured on our own dashboard: a string match for
// "button with no handler" flagged 8 controls and 0 were dead — disabled
// buttons and form submits. A veto built on Band B would bounce good work; a
// shortlist built on it costs one glance.
//
// Token-level on purpose. The factory reviews repos in other stacks where no
// JS/TS parser is installed, and the TS compiler API is not a stable target
// here (bun and node resolve different `typescript` builds). An AST check is a
// repo-local upgrade, not a factory dependency.
//
// Known limits, all on the Band B side: props spread (`{...props}`) supplying a
// handler, event delegation on a parent, a router target that exists outside
// the diff, and copy held in an attribute value (the attribute is stripped
// before matching, so an aria-label claim is not reported).

import { addedLines } from "./diff-walk";

export type ContentKind =
  | "dead-control" // Band A: the element cannot work as written
  | "dead-candidate" // Band B: looks dead, may be a submit/disabled/delegated
  | "ghost-link" // Band B: target cannot be resolved from the diff
  | "fake-claim" // Band B: a number or certification presented as fact
  | "buzzword"; // Band B: marketing filler, never failed

export type ContentBand = "A" | "B";

export interface ContentHit {
  file: string;
  line: number; // 1-based line number in the NEW file
  kind: ContentKind;
  band: ContentBand;
  text: string; // the trimmed source fragment the finding is about
}

export interface ScanContext {
  /**
   * Does this repo attach behaviour at runtime — listeners, refs, delegated
   * selectors, framework attributes? Default TRUE: assume it might, so a
   * missing handler is never called provable from the line alone. Only a
   * caller that has searched the tree may pass false.
   */
  runtimeWiring?: boolean;
}

const BANDS: Record<ContentKind, ContentBand> = {
  "dead-control": "A",
  "dead-candidate": "B",
  "ghost-link": "B",
  "fake-claim": "B",
  buzzword: "B",
};

const UI_FILE = /\.(?:tsx|jsx|html?|vue|svelte)$/;
const PUBLIC_DIR = /^public\//;
const TEST_FILE = /(?:\.(?:test|spec)\.[^.]+$)|(?:(?:^|\/)(?:__tests__|tests?)\/)/;

/** Is this a file whose added lines can reach a user as UI or copy? */
export function isUiPath(path: string): boolean {
  if (TEST_FILE.test(path)) return false;
  return UI_FILE.test(path) || PUBLIC_DIR.test(path);
}

const ELEMENT_START = /<(button|a|Link|NavLink)\b/;
const HAS_HANDLER = /\bon[A-Z][A-Za-z]*=/;
const EMPTY_HANDLER = /on[A-Z][A-Za-z]*=\{\s*\(\s*\)\s*=>\s*(?:\{\s*\}|undefined|null)\s*\}/;
const HREF_ATTR = /\bhref=/;
const TO_ATTR = /\bto=/;
const EMPTY_TARGET = /(?:\bhref|\bto)=\{?\s*["'](?:#|)["']\s*\}?/;
const HASH_TARGET = /(?:\bhref|\bto)=\{?\s*["']#[^"']+["']\s*\}?/;
const ROLE_BUTTON = /role=\{?\s*["']button["']\s*\}?/;
const DISABLED = /\bdisabled\b/;
const SUBMIT_TYPE = /\btype=/;
const SPREAD = /\{\.\.\./;

// Anything a script outside this element could attach to: a handle to look up
// (`id`, `ref`, `data-*`) or a props object that may carry a handler later.
const WIRING_HOOK = /\bref=|\bid=|\bdata-[\w-]+=|\bonclick=|\{\.\.\./;

/**
 * Is the missing behaviour provable, or could something outside the element
 * supply it? Both conditions are required: the repo attaches no behaviour at
 * runtime, and this element offers no handle to attach to.
 */
function isProvable(source: string, context: ScanContext): boolean {
  if (context.runtimeWiring ?? true) return false;
  return !WIRING_HOOK.test(source);
}

function bandFor(kind: ContentKind, provable: boolean): ContentBand {
  // Only "the element cannot work as written" can be provable. A candidate is
  // a question for the reviewer by definition.
  return kind === "dead-control" && provable ? "A" : "B";
}

type Reporter = (kind: ContentKind) => ContentHit[];

function classifyButton(source: string, report: Reporter): ContentHit[] {
  if (DISABLED.test(source) || SUBMIT_TYPE.test(source) || SPREAD.test(source)) return [];
  if (HAS_HANDLER.test(source)) return [];
  return report("dead-candidate");
}

function classifyLink(source: string, tag: string, report: Reporter): ContentHit[] {
  const hasTarget = (tag === "a" ? HREF_ATTR : TO_ATTR).test(source);
  if (HASH_TARGET.test(source)) return report("ghost-link");
  if (EMPTY_TARGET.test(source)) return HAS_HANDLER.test(source) ? [] : report("dead-control");
  if (hasTarget) return [];
  return HAS_HANDLER.test(source) ? [] : report("dead-control");
}

/** Classify one JSX/HTML opening element (may span several lines). */
export function scanElement(
  source: string,
  file = "",
  lineNo = 0,
  context: ScanContext = {},
): ContentHit[] {
  const tag = /<([A-Za-z]+)/.exec(source)?.[1] ?? "";
  const fragment = source.replace(/\s+/g, " ").trim().slice(0, 140);
  const provable = isProvable(source, context);
  const report: Reporter = (kind) => [
    {
      file,
      line: lineNo,
      kind,
      band: bandFor(kind, provable),
      text: fragment,
    },
  ];
  if (EMPTY_HANDLER.test(source)) return report("dead-control");
  if (tag === "button") return classifyButton(source, report);
  if (tag === "a" || tag === "Link" || tag === "NavLink") return classifyLink(source, tag, report);
  if (ROLE_BUTTON.test(source) && !HAS_HANDLER.test(source)) return report("dead-candidate");
  return [];
}

interface CopyPattern {
  re: RegExp;
  kind: ContentKind;
}

// Claims and filler, matched only against text that can reach a user. Order is
// specificity: a claim wins before the buzzword that may accompany it.
const COPY_PATTERNS: CopyPattern[] = [
  {
    re: /\b99(?:\.\d+)?%\s*(?:uptime|accuracy|success|coverage)\b/i,
    kind: "fake-claim",
  },
  {
    re: /\b\d+(?:\.\d+)?%\s*(?:uptime|faster|cheaper|less|more)\b/i,
    kind: "fake-claim",
  },
  {
    re: /\b\d+(?:\.\d+)?x\s+(?:faster|cheaper|more|less)\b/i,
    kind: "fake-claim",
  },
  {
    re: /\b\d+K\+?\s+(?:users|customers|developers|teams|companies)\b/i,
    kind: "fake-claim",
  },
  {
    re: /\b(?:SOC\s*2|ISO\s*27001|HIPAA|GDPR)\s*(?:compliant|certified|ready)\b/i,
    kind: "fake-claim",
  },
  {
    re: /\b(?:[Tt]rusted|[Uu]sed)\s+by\s+[A-Z0-9]/,
    kind: "fake-claim",
  },
  {
    re: /\bLighthouse\b|\bCore Web Vitals\b/,
    kind: "fake-claim",
  },
  {
    re: /\bseamless(?:ly)?\b/i,
    kind: "buzzword",
  },
  {
    re: /\brevolutionary\b/i,
    kind: "buzzword",
  },
  {
    re: /\bnext[\s-]generation\b/i,
    kind: "buzzword",
  },
  {
    re: /\bcutting[\s-]edge\b/i,
    kind: "buzzword",
  },
  {
    re: /\bAI[\s-]powered\b/i,
    kind: "buzzword",
  },
  {
    re: /\bgame[\s-]changing\b/i,
    kind: "buzzword",
  },
  {
    re: /\bsupercharge[ds]?\b/i,
    kind: "buzzword",
  },
  {
    re: /\b(?:world|best)[\s-](?:class|in[\s-]class)\b|\bstate[\s-]of[\s-]the[\s-]art\b/i,
    kind: "buzzword",
  },
];

// Attribute values are not copy: `className="seamless"` is a hook for a style,
// not a claim. Stripping them also keeps a colour token from reading as text.
const ATTRIBUTE_WITH_VALUE =
  /\b(?:className|class|id|href|to|src|alt|title|role|key|type|name|placeholder|style|aria-[\w-]+|data-[\w-]+)\s*=\s*(?:\{[^{}]*\}|"[^"]*"|'[^']*')/g;

/** The part of a line a user could read, with attribute values removed. */
export function visibleText(line: string): string {
  return line.replace(ATTRIBUTE_WITH_VALUE, " ");
}

/** Scan one line for user-facing copy problems. UI paths only. */
export function scanCopyLine(line: string, file = "", lineNo = 0): ContentHit[] {
  if (!isUiPath(file)) return [];
  const text = visibleText(line).trim();
  if (!text) return [];
  const hits: ContentHit[] = [];
  const seen = new Set<ContentKind>();
  for (const pattern of COPY_PATTERNS) {
    if (seen.has(pattern.kind) || !pattern.re.test(text)) continue;
    // One finding per kind per line: two claims in a sentence are one problem
    // to fix, not two report lines the reviewer has to re-read.
    seen.add(pattern.kind);
    hits.push({
      file,
      line: lineNo,
      kind: pattern.kind,
      band: BANDS[pattern.kind],
      text: text.slice(0, 140),
    });
  }
  return hits;
}

interface PendingElement {
  file: string;
  line: number;
  buffer: string;
}

/**
 * Does this added line close the opening tag? Arrow functions inside props
 * (`onClick={() => go()}`) and comparisons (`a >= b`) contain a `>` that is not
 * the tag's end, so they are blanked before looking.
 */
function closesTag(text: string): boolean {
  return text.replace(/=>|>=/g, "  ").includes(">");
}

/** Every content finding the diff's ADDED lines carry. */
export function addedContentHits(diff: string, context: ScanContext = {}): ContentHit[] {
  const hits: ContentHit[] = [];
  let pending: PendingElement | null = null;
  for (const added of addedLines(diff)) {
    if (pending && added.file !== pending.file) pending = null; // never leak across files
    if (pending) {
      pending.buffer = `${pending.buffer} ${added.text.trim()}`;
      if (!closesTag(added.text)) continue;
      hits.push(...scanElement(pending.buffer, pending.file, pending.line, context));
      pending = null;
      continue;
    }
    hits.push(...scanCopyLine(added.text, added.file, added.line));
    if (!ELEMENT_START.test(added.text)) continue;
    if (closesTag(added.text)) {
      hits.push(...scanElement(added.text, added.file, added.line, context));
      continue;
    }
    // The opening tag continues on later added lines: collect them first, so a
    // formatted multi-line element is classified once, not per line.
    pending = {
      file: added.file,
      line: added.line,
      buffer: added.text,
    };
  }
  return hits;
}

/** Compact, review-card-sized report. Never throws. */
export function formatContentReport(hits: ContentHit[], maxLines = 30): string {
  if (!hits.length) return "(none)";
  const bandA = hits.filter((h) => h.band === "A").length;
  const lines = hits
    .slice(0, maxLines)
    .map((h) => `${h.band} ${h.file}:${h.line} ${h.kind}  ${h.text.slice(0, 90)}`);
  const extra = hits.length - maxLines;
  const tail =
    extra > 0
      ? [
          `... ${extra} more content finding(s)`,
        ]
      : [];
  return [
    `${hits.length} content finding(s) added: ${bandA} Band A (no runtime wiring in this tree), ${hits.length - bandA} Band B (confirm by reading)`,
    ...lines,
    ...tail,
  ].join("\n");
}
