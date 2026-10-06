import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { measureBody, stripOldImages, guardSessionBody, IMAGE_PLACEHOLDER } from "../src/bodyGuard";

const img = (kb: number) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(kb * 1024) } });
const user = (uuid: string, content: unknown) => JSON.stringify({ type: "user", uuid, message: { role: "user", content } });
const asst = (uuid: string, text: string) => JSON.stringify({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });
const toolResultWithImage = (uuid: string, kb: number) =>
  user(uuid, [{ type: "tool_result", tool_use_id: "t" + uuid, content: [{ type: "text", text: "shot" }, img(kb)] }]);
const boundary = (preserved: string[] = []) =>
  JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { preservedMessages: { allUuids: preserved } } });

test("measures nested tool_result screenshots, not only top-level images", () => {
  const lines = [user("u1", "hi"), toolResultWithImage("u2", 100), asst("a1", "ok")];
  const m = measureBody(lines);
  expect(m.images).toBe(1);
  expect(m.imageBytes).toBeGreaterThan(100 * 1024);
  expect(m.bytes).toBeGreaterThan(m.imageBytes);
});

test("only rows after the last compact boundary (plus preserved ones) count", () => {
  const lines = [toolResultWithImage("old", 500), toolResultWithImage("kept", 50), boundary(["kept"]), user("u3", "new"), asst("a3", "ok")];
  const m = measureBody(lines);
  expect(m.images).toBe(1); // "kept" is preserved; "old" is behind the boundary
  expect(m.liveStart).toBe(3);
});

test("strips older screenshots, keeps the most recent rows and every other line byte-identical", () => {
  const lines = [user("u0", "start"), toolResultWithImage("u1", 50), asst("a1", "one"), toolResultWithImage("u2", 50), asst("a2", "two")];
  const out = stripOldImages(lines, 2);
  expect(out.removed).toBe(1);
  expect(out.lines[1]).toContain(IMAGE_PLACEHOLDER);
  expect(out.lines[3]).toBe(lines[3]); // inside the protected tail
  expect(out.lines[0]).toBe(lines[0]);
  expect(out.lines[2]).toBe(lines[2]);
  const parsed = JSON.parse(out.lines[1]);
  expect(parsed.message.content[0].type).toBe("tool_result");
  expect(parsed.message.content[0].content[0].text).toBe("shot");
});

test("guard leaves a small session untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "bodyguard-"));
  const p = join(dir, "s.jsonl");
  const body = [user("u1", "hi"), asst("a1", "ok")].join("\n") + "\n";
  writeFileSync(p, body);
  expect(guardSessionBody(p, 1024 * 1024)).toBeNull();
  expect(readFileSync(p, "utf8")).toBe(body);
  expect(readdirSync(dir).length).toBe(1);
});

test("guard strips an oversized session, writes a backup, and reports no compact needed", () => {
  const dir = mkdtempSync(join(tmpdir(), "bodyguard-"));
  const p = join(dir, "s.jsonl");
  const lines = [user("u0", "start")];
  for (let i = 1; i <= 10; i++) lines.push(toolResultWithImage("u" + i, 200), asst("a" + i, "step " + i));
  writeFileSync(p, lines.join("\n") + "\n");
  const r = guardSessionBody(p, 1024 * 1024, 2)!;
  expect(r).not.toBeNull();
  expect(r.before.bytes).toBeGreaterThan(1024 * 1024);
  expect(r.removed).toBe(9); // the 10th screenshot sits in the protected tail
  expect(r.after.bytes).toBeLessThan(1024 * 1024);
  expect(r.needsCompact).toBe(false);
  expect(r.backup && existsSync(r.backup)).toBe(true);
  expect(readFileSync(r.backup!, "utf8")).toBe(lines.join("\n") + "\n");
  expect(readFileSync(p, "utf8").endsWith("\n")).toBe(true);
});

test("guard asks for a compact when text alone is over the limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "bodyguard-"));
  const p = join(dir, "s.jsonl");
  const lines = [user("u0", "x".repeat(300 * 1024)), asst("a0", "y".repeat(300 * 1024))];
  writeFileSync(p, lines.join("\n") + "\n");
  const r = guardSessionBody(p, 100 * 1024)!;
  expect(r.removed).toBe(0);
  expect(r.backup).toBeUndefined();
  expect(r.needsCompact).toBe(true);
  expect(readFileSync(p, "utf8")).toBe(lines.join("\n") + "\n");
});
