// Shared diff walking for the static scanners. One place knows how a unified
// diff's ADDED lines map to a file and a NEW-side line number, so every
// scanner (suppressions, comments, content) counts the same way and the
// reviewer never sees two scans disagree about where a line is.
//
// Pure and dependency-free: both the factory (review card) and the CLIs run
// this over the same bytes, and no scanner needs a model to read files.

export interface AddedLine {
  file: string;
  line: number; // 1-based line number in the NEW file
  text: string;
}

/**
 * Blank out string-literal contents before matching, so a marker that appears
 * as DATA — test fixtures, docs quoting a marker, a scanner's own pattern
 * table — is never counted as a real finding. A real marker is a comment or
 * code, never the contents of a string.
 */
export function stripStrings(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) =>
    (m[0] ?? '"').repeat(m.length),
  );
}

/**
 * Every added line in a unified diff, with its file and NEW-side line number.
 * Context lines advance the new side; deleted lines, `---`/`+++` headers and
 * git's no-newline marker carry no NEW content, so they advance nothing.
 */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = "";
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      file = raw.slice(6).trim();
      continue;
    }
    if (raw.startsWith("@@ ")) {
      newLine = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
      continue;
    }
    if (raw.startsWith("\\") || !raw.startsWith("+")) {
      if (!raw.startsWith("-") && !raw.startsWith("\\")) newLine++;
      continue;
    }
    out.push({
      file,
      line: newLine,
      text: raw.slice(1),
    });
    newLine++;
  }
  return out;
}
