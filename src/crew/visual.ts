import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { z } from "zod";

// Visual Review: screenshot diffs of new/affected pages, Argos-style.
// The planner declares key moments, the builder implements them as an
// e2e spec (visual.moments.json), and the factory captures the same
// moments on the base commit (baseline) and on the feature worktree
// (after), pixel-diffs them, and parks the task for the owner when
// anything changed or is new. Screenshots live ONLY under the factory
// data dir (tasks/<id>/visual/) — never in the worktree, never in git.

export const VisualActionSchema = z.object({
  type: z.enum([
    "click",
    "fill",
    "press",
    "wait",
  ]),
  selector: z.string().default(""),
  value: z.string().default(""),
});
export type VisualAction = z.infer<typeof VisualActionSchema>;

export const VisualMomentSchema = z.object({
  name: z.string().min(1),
  route: z.string().min(1),
  viewport: z.string().default("1280x720"),
  actions: z.array(VisualActionSchema).default([]),
});
export type VisualMoment = z.infer<typeof VisualMomentSchema>;

export const VisualShotSchema = z.object({
  name: z.string(),
  route: z.string().default(""),
  viewport: z.string().default(""),
  status: z.enum([
    "new",
    "changed",
    "unchanged",
    "missing-after",
    "error",
  ]),
  diffRatio: z.number().default(0),
  diffPixels: z.number().int().default(0),
  totalPixels: z.number().int().default(0),
  width: z.number().int().default(0),
  height: z.number().int().default(0),
  baseline: z.string().default(""), // store-relative, e.g. baseline/home.png
  after: z.string().default(""),
  diff: z.string().default(""),
  afterHash: z.string().default(""), // sha256 of the after PNG; owner approval pins these
  error: z.string().default(""),
});
export type VisualShot = z.infer<typeof VisualShotSchema>;

export const VisualCommentSchema = z.object({
  shot: z.string().default(""), // shot name, "" = whole review
  comment: z.string(),
  at: z.string(),
});
export type VisualComment = z.infer<typeof VisualCommentSchema>;

export const VisualReviewSchema = z.object({
  taskId: z.string(),
  status: z.enum([
    "pending",
    "passed",
    "approved",
    "changes-requested",
    "skipped",
    "error",
  ]),
  at: z.string(),
  baseCommit: z.string().default(""),
  threshold: z.number().default(0.001),
  reason: z.string().default(""),
  shots: z.array(VisualShotSchema).default([]),
  comments: z.array(VisualCommentSchema).default([]),
});
export type VisualReview = z.infer<typeof VisualReviewSchema>;

export const VISUAL_STATUSES = [
  "none",
  "pending",
  "passed",
  "approved",
  "changes-requested",
  "skipped",
  "error",
] as const;
export type VisualState = (typeof VISUAL_STATUSES)[number];

export const DEFAULT_DIFF_THRESHOLD = 0.001; // fraction of pixels allowed to differ
const PIXEL_DELTA = 16; // per-channel delta (0-255) that counts a pixel as changed
const PAGE_FILE = /\.(tsx|jsx|vue|svelte|astro|html|css|scss)$/i;

export function sanitizeShotName(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return clean || "shot";
}

function parseAction(part: string): VisualAction | null {
  const [head, ...rest] = part.trim().split(":");
  const kind = (head ?? "").trim().toLowerCase();
  const arg = rest.join(":").trim();
  if (kind === "click" && arg)
    return {
      type: "click",
      selector: arg,
      value: "",
    };
  if (kind === "press" && arg)
    return {
      type: "press",
      selector: "",
      value: arg,
    };
  if (kind === "wait")
    return {
      type: "wait",
      selector: "",
      value: String(Math.max(0, Number(arg) || 500)),
    };
  if (kind === "fill" && arg) {
    const eq = arg.indexOf("=");
    if (eq > 0)
      return {
        type: "fill",
        selector: arg.slice(0, eq).trim(),
        value: arg.slice(eq + 1).trim(),
      };
  }
  return null;
}

function parseActions(text: string): VisualAction[] {
  return text
    .split("|")
    .slice(1)
    .map(parseAction)
    .filter((a): a is VisualAction => a !== null);
}

/**
 * Key moments declared in a plan, under a `## Visual moments` heading.
 * Bullet forms: `- name: /route`, `- name: /route @1024x768`,
 * `- name: /route | click:#add | fill:#email=a@b.c | wait:500`.
 */
export function parseVisualMoments(plan: string): VisualMoment[] {
  const moments: VisualMoment[] = [];
  let inSection = false;
  for (const line of plan.split("\n")) {
    const heading = /^#{1,3}\s+(.*)/.exec(line);
    if (heading) {
      inSection = /visual|screenshot/i.test(heading[1] ?? "");
      continue;
    }
    if (!inSection) continue;
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const body = (bullet[1] ?? "").replace(/`/g, "");
    const m = /^([^:|]+?)\s*:\s*(\/\S*?)(?:\s+@(\d+x\d+))?\s*(\|.*)?$/.exec(body);
    if (!m) continue;
    moments.push({
      name: sanitizeShotName((m[1] ?? "").trim()),
      route: (m[2] ?? "/").trim(),
      viewport: m[3] ?? "1280x720",
      actions: parseActions(m[4] ?? ""),
    });
  }
  return moments;
}

/** The builder's e2e spec on disk: the same moments as JSON in the worktree. */
export function parseVisualMomentsJson(text: string): VisualMoment[] {
  try {
    const raw = JSON.parse(text) as unknown;
    const list = Array.isArray(raw)
      ? raw
      : (
          raw as {
            moments?: unknown;
          }
        )?.moments;
    if (!Array.isArray(list)) return [];
    const out: VisualMoment[] = [];
    for (const item of list) {
      const parsed = VisualMomentSchema.safeParse(item);
      if (parsed.success)
        out.push({
          ...parsed.data,
          name: sanitizeShotName(parsed.data.name),
        });
    }
    return out;
  } catch {
    return [];
  }
}

/** Moments for a task: the plan wins; the builder's spec file is the fallback. */
export function resolveVisualMoments(plan: string, worktree: string): VisualMoment[] {
  const fromPlan = parseVisualMoments(plan);
  if (fromPlan.length) return fromPlan;
  for (const rel of [
    "visual.moments.json",
    "e2e/visual.moments.json",
    "tests/visual.moments.json",
  ]) {
    try {
      const found = parseVisualMomentsJson(readFileSync(join(worktree, rel), "utf8"));
      if (found.length) return found;
    } catch {
      /* next candidate */
    }
  }
  return [];
}

export function isVisualRelevant(
  taskType: string,
  touchedFiles: string[],
  momentCount: number,
): boolean {
  if (momentCount > 0) return true;
  if (taskType === "ui" || taskType === "css") return true;
  return touchedFiles.some((f) => PAGE_FILE.test(f));
}

// --- Minimal PNG codec (8-bit, non-interlaced; Chromium screenshots) ---

interface RgbaImage {
  width: number;
  height: number;
  data: Buffer;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

const PNG_FILTERS: ((v: number, a: number, b: number, c: number) => number)[] = [
  (v) => v,
  (v, a) => v + a,
  (v, _a, b) => v + b,
  (v, a, b) => v + Math.floor((a + b) / 2),
  (v, a, b, c) => v + paeth(a, b, c),
];

function unfilterRow(row: Buffer, prev: Buffer, channels: number, filter: number): void {
  const apply = PNG_FILTERS[filter] ?? PNG_FILTERS[0]!;
  for (let x = 0; x < row.length; x++) {
    const a = x >= channels ? (row[x - channels] ?? 0) : 0;
    const b = prev[x] ?? 0;
    const c = x >= channels ? (prev[x - channels] ?? 0) : 0;
    row[x] = apply(row[x] ?? 0, a, b, c) & 0xff;
  }
}

type RowConverter = (
  row: Buffer,
  s: number,
) => [
  number,
  number,
  number,
  number,
];

function rowConverter(colorType: number, palette: number[], trns: number[]): RowConverter {
  if (colorType === 6)
    return (row, s) => [
      row[s] ?? 0,
      row[s + 1] ?? 0,
      row[s + 2] ?? 0,
      row[s + 3] ?? 0,
    ];
  if (colorType === 2)
    return (row, s) => [
      row[s] ?? 0,
      row[s + 1] ?? 0,
      row[s + 2] ?? 0,
      255,
    ];
  if (colorType === 0)
    return (row, s) => {
      const g = row[s] ?? 0;
      return [
        g,
        g,
        g,
        255,
      ];
    };
  return (row, s) => {
    const idx = (row[s] ?? 0) * 3;
    return [
      palette[idx] ?? 0,
      palette[idx + 1] ?? 0,
      palette[idx + 2] ?? 0,
      trns[row[s] ?? 0] ?? 255,
    ];
  };
}

function rowToRgba(
  row: Buffer,
  out: Buffer,
  y: number,
  width: number,
  channels: number,
  convert: RowConverter,
): void {
  for (let x = 0; x < width; x++) {
    const [r, g, b, a] = convert(row, x * channels);
    const d = (y * width + x) * 4;
    out[d] = r;
    out[d + 1] = g;
    out[d + 2] = b;
    out[d + 3] = a;
  }
}

interface PngHeader {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  interlace: number;
  idat: Buffer[];
  palette: number[];
  trns: number[];
}

function applyPngChunk(h: PngHeader, type: string, data: Buffer): boolean {
  if (type === "IHDR") {
    h.width = data.readUInt32BE(0);
    h.height = data.readUInt32BE(4);
    h.bitDepth = data[8] ?? 0;
    h.colorType = data[9] ?? -1;
    h.interlace = data[12] ?? 0;
  } else if (type === "PLTE")
    for (let i = 0; i + 2 < data.length; i += 3)
      h.palette.push(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
  else if (type === "tRNS") for (const b of data) h.trns.push(b);
  else if (type === "IDAT") h.idat.push(Buffer.from(data));
  return type === "IEND";
}

function parsePngChunks(buf: Buffer): PngHeader {
  const h: PngHeader = {
    width: 0,
    height: 0,
    colorType: -1,
    bitDepth: 0,
    interlace: 0,
    idat: [],
    palette: [],
    trns: [],
  };
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const done = applyPngChunk(
      h,
      buf.toString("ascii", off + 4, off + 8),
      buf.subarray(off + 8, off + 8 + len),
    );
    off += 8 + len + 4;
    if (done) break;
  }
  return h;
}

const PNG_CHANNELS: Record<number, number> = {
  6: 4,
  2: 3,
  0: 1,
  3: 1,
};

export function decodePng(buf: Buffer): RgbaImage {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  const { width, height, colorType, bitDepth, interlace, idat, palette, trns } =
    parsePngChunks(buf);
  if (!width || bitDepth !== 8 || interlace !== 0)
    throw new Error(`unsupported PNG (bitDepth=${bitDepth}, interlace=${interlace})`);
  const channels = PNG_CHANNELS[colorType] ?? -1;
  if (channels < 0) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const convert = rowConverter(colorType, palette, trns);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1);
    const row = Buffer.from(raw.subarray(rowOff + 1, rowOff + 1 + stride));
    unfilterRow(row, prev, channels, raw[rowOff] ?? 0);
    rowToRgba(row, out, y, width, channels, convert);
    prev = row;
  }
  return {
    width,
    height,
    data: out,
  };
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([
    Buffer.from(type, "ascii"),
    data,
  ]);
  // CRC32
  let crc = 0xffffffff;
  for (const b of body) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([
    len,
    body,
    crcBuf,
  ]);
}

export function encodePng(img: RgbaImage): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: Buffer[] = [];
  for (let y = 0; y < img.height; y++) {
    rows.push(
      Buffer.from([
        0,
      ]),
      img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4),
    );
  }
  return Buffer.concat([
    Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function hashPng(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface PngDiff {
  diffRatio: number;
  diffPixels: number;
  totalPixels: number;
  width: number;
  height: number;
  sizeMismatch: boolean;
  diffPng: Buffer;
}

function paintDiffPixel(
  a: RgbaImage,
  b: RgbaImage,
  i: number,
  diffData: Buffer,
  pixelDelta: number,
): boolean {
  const x = i % b.width;
  const y = Math.floor(i / b.width);
  const d = i * 4;
  const inside = x < a.width && y < a.height;
  const ax = inside ? (y * a.width + x) * 4 : -1;
  const changed =
    !inside ||
    (ax >= 0 &&
      Math.max(
        Math.abs((a.data[ax] ?? 0) - (b.data[d] ?? 0)),
        Math.abs((a.data[ax + 1] ?? 0) - (b.data[d + 1] ?? 0)),
        Math.abs((a.data[ax + 2] ?? 0) - (b.data[d + 2] ?? 0)),
      ) > pixelDelta);
  if (changed) {
    diffData[d] = 255;
    diffData[d + 3] = 255;
    return true;
  }
  diffData[d] = Math.round(((b.data[d] ?? 0) + 255) / 2);
  diffData[d + 1] = Math.round(((b.data[d + 1] ?? 0) + 255) / 2);
  diffData[d + 2] = Math.round(((b.data[d + 2] ?? 0) + 255) / 2);
  diffData[d + 3] = 255;
  return false;
}

/** Pixel-diff two PNGs; changed pixels are painted red over the faded after-image. */
export function comparePngs(baseline: Buffer, after: Buffer, pixelDelta = PIXEL_DELTA): PngDiff {
  const a = decodePng(baseline);
  const b = decodePng(after);
  const sizeMismatch = a.width !== b.width || a.height !== b.height;
  const total = b.width * b.height;
  const diffData = Buffer.alloc(total * 4);
  let diffPixels = 0;
  for (let i = 0; i < total; i++) {
    if (paintDiffPixel(a, b, i, diffData, pixelDelta)) diffPixels++;
  }
  if (sizeMismatch) diffPixels = total;
  return {
    diffRatio: total ? diffPixels / total : 0,
    diffPixels,
    totalPixels: total,
    width: b.width,
    height: b.height,
    sizeMismatch,
    diffPng: encodePng({
      width: b.width,
      height: b.height,
      data: diffData,
    }),
  };
}

/** Classify one shot from its files on disk (paths may be missing). */
export function classifyShot(input: {
  name: string;
  route: string;
  viewport: string;
  baselinePng: Buffer | null;
  afterPng: Buffer | null;
  threshold?: number;
}): {
  shot: Omit<VisualShot, "baseline" | "after" | "diff">;
  diffPng: Buffer | null;
} {
  const base = {
    name: input.name,
    route: input.route,
    viewport: input.viewport,
    afterHash: input.afterPng ? hashPng(input.afterPng) : "",
  };
  if (!input.afterPng)
    return {
      shot: {
        ...base,
        status: "missing-after",
        diffRatio: 0,
        diffPixels: 0,
        totalPixels: 0,
        width: 0,
        height: 0,
        error: "no screenshot captured on the feature branch",
      },
      diffPng: null,
    };
  const dims = (() => {
    try {
      const d = decodePng(input.afterPng);
      return {
        width: d.width,
        height: d.height,
      };
    } catch {
      return {
        width: 0,
        height: 0,
      };
    }
  })();
  if (!input.baselinePng)
    return {
      shot: {
        ...base,
        ...dims,
        status: "new",
        diffRatio: 1,
        diffPixels: dims.width * dims.height,
        totalPixels: dims.width * dims.height,
        error: "",
      },
      diffPng: null,
    };
  try {
    const diff = comparePngs(input.baselinePng, input.afterPng);
    const changed =
      diff.sizeMismatch || diff.diffRatio > (input.threshold ?? DEFAULT_DIFF_THRESHOLD);
    return {
      shot: {
        ...base,
        status: changed ? "changed" : "unchanged",
        diffRatio: diff.diffRatio,
        diffPixels: diff.diffPixels,
        totalPixels: diff.totalPixels,
        width: diff.width,
        height: diff.height,
        error: diff.sizeMismatch ? "screenshot size changed" : "",
      },
      diffPng: changed ? diff.diffPng : null,
    };
  } catch (err) {
    return {
      shot: {
        ...base,
        ...dims,
        status: "error",
        diffRatio: 0,
        diffPixels: 0,
        totalPixels: 0,
        error: err instanceof Error ? err.message : String(err),
      },
      diffPng: null,
    };
  }
}

export function changedShots(review: VisualReview): VisualShot[] {
  return review.shots.filter(
    (s) =>
      s.status === "changed" ||
      s.status === "new" ||
      s.status === "missing-after" ||
      s.status === "error",
  );
}

/** Owner approval pins after-hashes; a re-capture with the same hashes passes. */
export function approvalCovers(review: VisualReview, approvedHashes: string[]): boolean {
  const approved = new Set(approvedHashes);
  const changed = changedShots(review);
  return changed.length > 0 && changed.every((s) => s.afterHash && approved.has(s.afterHash));
}

export type VisualGateAction = "pass" | "park" | "bounce";
export function visualGateAction(
  review: VisualReview | null,
  approvedHashes: string[],
): {
  action: VisualGateAction;
  reason: string;
} {
  if (
    !review ||
    review.status === "skipped" ||
    review.status === "passed" ||
    review.status === "approved"
  )
    return {
      action: "pass",
      reason: review?.reason ?? "",
    };
  if (review.status === "error")
    return {
      action: "park",
      reason: review.reason || "visual capture failed",
    };
  if (approvalCovers(review, approvedHashes))
    return {
      action: "pass",
      reason: "owner approved these exact screenshots",
    };
  const changed = changedShots(review);
  if (!changed.length)
    return {
      action: "pass",
      reason: "no visual changes",
    };
  return {
    action: "park",
    reason: `${changed.length} screenshot(s) new or changed: ${changed.map((s) => `${s.name} (${s.status}${s.status === "changed" ? ` ${(s.diffRatio * 100).toFixed(2)}%` : ""})`).join(", ")}`,
  };
}

export type CaptureFn = (opts: {
  cwd: string;
  moments: VisualMoment[];
  outDir: string;
}) => Promise<void>;

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(250);
  }
  throw new Error(`server did not come up at ${url}`);
}

/**
 * Default capture: optionally spawn the project's dev server in `cwd`,
 * then screenshot every moment with Playwright. Writes <name>.png per
 * moment into outDir (which the caller keeps outside git).
 */
async function applyVisualActions(
  page: import("playwright").Page,
  actions: VisualAction[],
): Promise<void> {
  for (const action of actions) {
    if (action.type === "fill") await page.fill(action.selector, action.value).catch(() => {});
    else if (action.type === "click")
      await page
        .click(action.selector, {
          timeout: 5000,
        })
        .catch(() => {});
    else if (action.type === "press") await page.keyboard.press(action.value).catch(() => {});
    else await page.waitForTimeout(Math.min(5000, Number(action.value) || 500));
  }
}

async function captureMoment(
  browser: import("playwright").Browser,
  moment: VisualMoment,
  baseUrl: string,
  outDir: string,
): Promise<void> {
  const [w, h] = moment.viewport.split("x").map(Number);
  const page = await browser.newPage({
    viewport: {
      width: w || 1280,
      height: h || 720,
    },
  });
  const url = new URL(moment.route, baseUrl).toString();
  await page
    .goto(url, {
      waitUntil: "networkidle",
      timeout: 30_000,
    })
    .catch(async () =>
      page.goto(url, {
        waitUntil: "load",
        timeout: 30_000,
      }),
    );
  await applyVisualActions(page, moment.actions);
  await page.screenshot({
    path: join(outDir, `${sanitizeShotName(moment.name)}.png`),
  });
  await page.close();
}

export async function captureMoments(opts: {
  cwd: string;
  moments: VisualMoment[];
  outDir: string;
  serverCommand?: string;
  serverPort?: number;
  baseUrl?: string;
}): Promise<void> {
  mkdirSync(opts.outDir, {
    recursive: true,
  });
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const baseUrl = opts.baseUrl ?? (opts.serverPort ? `http://127.0.0.1:${opts.serverPort}` : "");
  try {
    if (opts.serverCommand && opts.serverPort) {
      proc = Bun.spawn(
        [
          "sh",
          "-c",
          opts.serverCommand,
        ],
        {
          cwd: opts.cwd,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PORT: String(opts.serverPort),
          },
        },
      );
      await waitForUrl(baseUrl, 30_000);
    }
    if (!baseUrl)
      throw new Error(
        "no base URL: configure the project's dev command and port, or pass a base URL",
      );
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      for (const moment of opts.moments) await captureMoment(browser, moment, baseUrl, opts.outDir);
    } finally {
      await browser.close();
    }
  } finally {
    proc?.kill();
  }
}

/**
 * Capture the same moments at a past commit: export it with git archive
 * into a temp dir outside any repo, link node_modules from the feature
 * worktree so the dev server can run, capture, and clean up.
 */
export async function captureAtCommit(opts: {
  repo: string;
  commit: string;
  moments: VisualMoment[];
  outDir: string;
  serverCommand?: string;
  serverPort?: number;
  nodeModulesFrom?: string;
}): Promise<void> {
  assertOutsideWorktree(opts.repo, opts.outDir);
  const tmp = join(tmpdir(), `visual-baseline-${opts.commit.slice(0, 12)}-${Date.now()}`);
  mkdirSync(tmp, {
    recursive: true,
  });
  try {
    const archive = execFileSync(
      "git",
      [
        "archive",
        opts.commit,
      ],
      {
        cwd: opts.repo,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    execFileSync(
      "tar",
      [
        "-x",
        "-C",
        tmp,
      ],
      {
        input: archive,
      },
    );
    if (
      opts.nodeModulesFrom &&
      existsSync(join(opts.nodeModulesFrom, "node_modules")) &&
      !existsSync(join(tmp, "node_modules"))
    ) {
      try {
        execFileSync("ln", [
          "-s",
          join(opts.nodeModulesFrom, "node_modules"),
          join(tmp, "node_modules"),
        ]);
      } catch {
        /* capture may still work */
      }
    }
    await captureMoments({
      cwd: tmp,
      moments: opts.moments,
      outDir: opts.outDir,
      serverCommand: opts.serverCommand,
      serverPort: opts.serverPort,
    });
  } finally {
    rmSync(tmp, {
      recursive: true,
      force: true,
    });
  }
}

/** Screenshots must never land inside a git worktree/repo. */
export function assertOutsideWorktree(worktree: string, outDir: string): void {
  const wt = resolve(worktree);
  const out = resolve(outDir);
  if (out === wt || out.startsWith(wt + sep))
    throw new Error(`visual output must live outside the git worktree (${wt}): ${out}`);
}
