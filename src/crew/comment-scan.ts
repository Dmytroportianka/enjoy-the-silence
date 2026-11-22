// Comment hygiene scanner: finds comments a diff ADDS that carry no
// information — decorative banners, workflow narration, empty labels, vague
// TODOs, decorative emoji, end markers. Ported from the `antislop-code`
// ruleset, the one part of anti-slop that matches this repo's existing stance
// ("explain why; every silence carries a reason").
//
// Report-only by design. A finding is evidence on the reviewer card, never a
// REJECT on its own: a decorative comment can still be a REJECT reason under
// PATTERNS.md, but that is the reviewer's judgment to make from the quoted
// line, not a regex's.
//
// Deliberately not detected: "this comment restates the next line". That means
// comparing a comment to the code beneath it, which is a judgment call — the
// reviewer makes it, and PATTERNS.md states the rule.

import { addedLines, stripStrings } from "./diff-walk";

export type CommentKind =
  | "banner" // decorative separator or ALL-CAPS section label
  | "narration" // "Step 1:", "First,", "Finally,"
  | "empty-label" // "Main logic", "Helper", "Error handling"
  | "vague-todo" // "TODO: improve this", "Future improvements"
  | "emoji" // ✅ 🚀 🔒 as decoration
  | "end-marker"; // "} // end if", "# End of function"

export interface CommentHit {
  file: string;
  line: number; // 1-based line number in the NEW file
  kind: CommentKind;
  text: string; // the trimmed added line
}

// Comment syntax is per language family, never guessed per line: a `#` in a
// YAML file is a comment, a `#` in a TSX file is a type-private field.
const HASH_COMMENT = /\.(?:py|pyi|sh|bash|zsh|rb|pl|ps1|ya?ml|toml|ini|conf|nix|r|jl)$/;
const DASH_COMMENT = /\.(?:sql|lua|hs|elm)$/;
const MARKUP_COMMENT = /\.(?:html?|md|mdx|vue|svelte|xml|svg)$/;

const SEPARATOR = /^[=\-─━~*#_+]{3,}/;
const SEPARATOR_BOTH_SIDES = /^[=\-─━~*#_+]{2,}\s*\S[\s\S]*\s*[=\-─━~*#_+]{2,}$/;
const CAPS_LABEL = /^[A-Z][A-Z0-9 &/_-]{1,39}$/;
const NARRATION = /^(?:step\s*\d+|first|next|then|finally|afterwards)\s*[,:]/i;
const EMPTY_LABEL =
  /^(?:main|core|business|helper|utility|utils?|entry\s*point|error\s*handling|logic|misc|general|setup)$/i;
const EMPTY_LABEL_SUFFIX = /^(?:main|core|business|helper|entry)\s+(?:logic|function|code|stuff)$/i;
const TODO = /^(?:TODO|FIXME|HACK|XXX)\b\s*[:,-]?\s*(.*)$/i;
const VAGUE_TODO =
  /^(?:improve|better|optimi[sz]e|clean\s*up|cleanup|refactor|fix\s+(?:this|it)|address\s+this|more\s+validation|add\s+more|future|later|someday|handle\s+edge\s+cases?)\b/i;
const DECORATIVE_EMOJI =
  /[\u2705\u2714\u26A0\u2728\u274C\u{1F680}\u{1F512}\u{1F3AF}\u{1F525}\u{1F4A1}\u{1F4DD}]/u;
// End-of-block markers only when the line ENDS there: "// end if" is a marker,
// "// close the socket after the handshake" is a sentence about the socket.
const END_MARKER =
  /(?:\/\/|#|--)\s*(?:end|close)(?:\s+(?:of\s+)?(?:if|for|while|function|fn|class|block|loop|switch|method|try|catch|section))?\s*$/i;

function delimited(text: string, open: string, close?: string): string | null {
  if (!text.startsWith(open)) return null;
  let body = text.slice(open.length);
  if (close && body.endsWith(close)) body = body.slice(0, -close.length);
  return body.trim();
}

/** The comment body when the line is a comment and nothing else, else null. */
function commentBody(file: string, line: string): string | null {
  const bare = stripStrings(line).trim();
  if (MARKUP_COMMENT.test(file)) return delimited(bare, "<!--", "-->");
  if (HASH_COMMENT.test(file)) return delimited(bare, "#");
  if (DASH_COMMENT.test(file)) return delimited(bare, "--");
  if (bare.startsWith("//")) return delimited(bare, "//");
  if (bare.startsWith("/*")) return delimited(bare, "/*", "*/");
  // continuation line inside a block comment: " * reason"
  if (/^\*(?!\/)/.test(bare)) return bare.slice(1).trim();
  return null;
}

function isBanner(body: string): boolean {
  if (SEPARATOR.test(body) || SEPARATOR_BOTH_SIDES.test(body)) return true;
  // One-word caps labels ("NOTE", "CORS") are too ambiguous to judge; two or
  // more words ("MAIN LOGIC", "SETUP HELPERS") are the AI banner shape.
  if (/^(?:TODO|FIXME|HACK|XXX)\b/.test(body)) return false;
  return CAPS_LABEL.test(body) && body.trim().split(/\s+/).length >= 2;
}

function isVagueTodo(body: string): boolean {
  const rest = TODO.exec(body)?.[1]?.trim() ?? null;
  if (rest === null) return false;
  return rest.length === 0 || VAGUE_TODO.test(rest);
}

function isEmptyLabel(body: string): boolean {
  return EMPTY_LABEL.test(body) || EMPTY_LABEL_SUFFIX.test(body);
}

function smellOf(body: string): CommentKind | null {
  if (isBanner(body)) return "banner";
  if (isVagueTodo(body)) return "vague-todo";
  if (NARRATION.test(body)) return "narration";
  if (isEmptyLabel(body)) return "empty-label";
  if (DECORATIVE_EMOJI.test(body)) return "emoji";
  return null;
}

/** Scan one line; returns the comment finding it carries, or null. */
export function scanCommentLine(line: string, file = "", lineNo = 0): CommentHit | null {
  const text = line.trim();
  if (!text) return null;
  if (END_MARKER.test(stripStrings(text))) {
    return {
      file,
      line: lineNo,
      kind: "end-marker",
      text,
    };
  }
  const body = commentBody(file, line);
  if (body === null) return null;
  const kind = smellOf(body);
  if (!kind) return null;
  return {
    file,
    line: lineNo,
    kind,
    text,
  };
}

/** Every comment finding the diff's ADDED lines carry. */
export function addedCommentHits(diff: string): CommentHit[] {
  const hits: CommentHit[] = [];
  for (const added of addedLines(diff)) {
    const hit = scanCommentLine(added.text, added.file, added.line);
    if (hit) hits.push(hit);
  }
  return hits;
}

/** Compact, review-card-sized report. Never throws. */
export function formatCommentReport(hits: CommentHit[], maxLines = 30): string {
  if (!hits.length) return "(none)";
  const counts = new Map<CommentKind, number>();
  for (const h of hits) counts.set(h.kind, (counts.get(h.kind) ?? 0) + 1);
  const breakdown = [
    ...counts.entries(),
  ]
    .map(([kind, n]) => `${n} ${kind}`)
    .join(", ");
  const lines = hits
    .slice(0, maxLines)
    .map((h) => `${h.file}:${h.line} ${h.kind}  ${h.text.slice(0, 80)}`);
  const extra = hits.length - maxLines;
  const tail =
    extra > 0
      ? [
          `... ${extra} more comment finding(s)`,
        ]
      : [];
  return [
    `${hits.length} comment finding(s) added: ${breakdown}`,
    ...lines,
    ...tail,
  ].join("\n");
}
