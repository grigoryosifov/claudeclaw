/**
 * Session body guard.
 *
 * Every resumed turn re-uploads the session's live context (everything after the
 * last compact boundary, plus the messages the boundary preserved). Screenshots the
 * bot took through Read or the browser tools ride along as base64, usually nested
 * inside tool_result blocks. On a host with a thin or bursty uplink a body past a
 * few MB makes the upload die (`API Error: Connection dropped (ECONNRESET)`), and
 * /compact cannot help on its own because it uploads the same body.
 *
 * Before a resumed run the guard measures that body; past the limit it replaces
 * older screenshots with a text placeholder (backup beside the transcript), and the
 * caller compacts when stripping alone does not bring it under the limit.
 */
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const IMAGE_PLACEHOLDER =
  "[screenshot removed by the claudeclaw body guard to keep the request under the upload limit]";

export interface BodyMeasure {
  /** Approximate request bytes: JSON size of every live message's content. */
  bytes: number;
  /** Image blocks in the live context, top-level or nested inside tool_result. */
  images: number;
  /** Bytes those image blocks account for. */
  imageBytes: number;
  /** Index of the first live row (0 when the session was never compacted). */
  liveStart: number;
}

interface Row {
  type?: string;
  subtype?: string;
  uuid?: string;
  message?: { content?: unknown };
  compactMetadata?: { preservedMessages?: { allUuids?: string[]; uuids?: string[] } };
}

function parse(line: string): Row | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as Row;
  } catch {
    return null;
  }
}

/** Rows that go into the next request: after the last compact boundary, plus the ones it preserved. */
function liveRows(rows: (Row | null)[]): { start: number; preserved: Set<string> } {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r?.type === "system" && r.subtype === "compact_boundary") {
      const pm = r.compactMetadata?.preservedMessages;
      return { start: i + 1, preserved: new Set(pm?.allUuids ?? pm?.uuids ?? []) };
    }
  }
  return { start: 0, preserved: new Set() };
}

function isLive(rows: (Row | null)[], i: number, live: { start: number; preserved: Set<string> }): boolean {
  const r = rows[i];
  if (!r || (r.type !== "user" && r.type !== "assistant")) return false;
  return i >= live.start || (r.uuid !== undefined && live.preserved.has(r.uuid));
}

function isImage(block: unknown): boolean {
  return !!block && typeof block === "object" && (block as { type?: string }).type === "image";
}

/** Count images in a content array, including those nested in tool_result.content. */
function countImages(content: unknown): { n: number; bytes: number } {
  let n = 0;
  let bytes = 0;
  if (!Array.isArray(content)) return { n, bytes };
  for (const block of content) {
    if (isImage(block)) {
      n++;
      bytes += JSON.stringify(block).length;
    } else if (block && typeof block === "object" && Array.isArray((block as { content?: unknown }).content)) {
      const inner = countImages((block as { content: unknown[] }).content);
      n += inner.n;
      bytes += inner.bytes;
    }
  }
  return { n, bytes };
}

export function measureBody(lines: string[]): BodyMeasure {
  const rows = lines.map(parse);
  const live = liveRows(rows);
  let bytes = 0;
  let images = 0;
  let imageBytes = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!isLive(rows, i, live)) continue;
    const content = rows[i]!.message?.content;
    bytes += JSON.stringify(content ?? "").length;
    const c = countImages(content);
    images += c.n;
    imageBytes += c.bytes;
  }
  return { bytes, images, imageBytes, liveStart: live.start };
}

function stripContent(content: unknown): { content: unknown; removed: number } {
  if (!Array.isArray(content)) return { content, removed: 0 };
  let removed = 0;
  const out = content.map((block) => {
    if (isImage(block)) {
      removed++;
      return { type: "text", text: IMAGE_PLACEHOLDER };
    }
    if (block && typeof block === "object" && Array.isArray((block as { content?: unknown }).content)) {
      const inner = stripContent((block as { content: unknown[] }).content);
      removed += inner.removed;
      return { ...(block as object), content: inner.content };
    }
    return block;
  });
  return { content: out, removed };
}

/**
 * Replace image blocks in live rows, except in the last `keepLastRows` live rows
 * (the screenshot the bot is working from right now stays). Rows are rewritten only
 * when they carried an image; every other line is returned byte-identical.
 */
export function stripOldImages(lines: string[], keepLastRows = 6): { lines: string[]; removed: number } {
  const rows = lines.map(parse);
  const live = liveRows(rows);
  const liveIdx: number[] = [];
  for (let i = 0; i < rows.length; i++) if (isLive(rows, i, live)) liveIdx.push(i);
  const protect = new Set(liveIdx.slice(Math.max(0, liveIdx.length - keepLastRows)));
  let removed = 0;
  const out = lines.slice();
  for (const i of liveIdx) {
    if (protect.has(i)) continue;
    const r = rows[i]!;
    if (!r.message || countImages(r.message.content).n === 0) continue;
    const s = stripContent(r.message.content);
    removed += s.removed;
    out[i] = JSON.stringify({ ...r, message: { ...r.message, content: s.content } });
  }
  return { lines: out, removed };
}

export interface GuardResult {
  before: BodyMeasure;
  after: BodyMeasure;
  removed: number;
  backup?: string;
  /** True when the body is still over the limit after stripping; the caller compacts. */
  needsCompact: boolean;
}

/**
 * Measure the transcript at `path`; when its live body exceeds `maxBytes`, back it up
 * beside itself and strip older screenshots. Returns null when nothing had to change.
 * The caller runs this only when no claude child is writing the session.
 */
export function guardSessionBody(path: string, maxBytes: number, keepLastRows = 6): GuardResult | null {
  const raw = readFileSync(path, "utf8");
  const trailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (trailingNewline) lines.pop();
  const before = measureBody(lines);
  if (before.bytes <= maxBytes) return null;
  let removed = 0;
  let after = before;
  let backup: string | undefined;
  if (before.images > 0) {
    const stripped = stripOldImages(lines, keepLastRows);
    removed = stripped.removed;
    if (removed > 0) {
      backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "")}`;
      copyFileSync(path, backup);
      const tmp = `${path}.guard-tmp`;
      writeFileSync(tmp, stripped.lines.join("\n") + (trailingNewline ? "\n" : ""));
      renameSync(tmp, path);
      after = measureBody(stripped.lines);
    }
  }
  return { before, after, removed, backup, needsCompact: after.bytes > maxBytes };
}
