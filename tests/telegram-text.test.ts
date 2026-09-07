import { test, expect } from "bun:test";
import {
  splitTelegramText,
  renderTelegramChunks,
  markdownToTelegramHtml,
  TELEGRAM_SOFT_LEN,
  TELEGRAM_MAX_LEN,
} from "../src/telegramText";

const para = (i: number) => `Paragraph ${i}: ` + "lorem ipsum dolor sit amet ".repeat(12).trim();

test("short text is a single chunk", () => {
  expect(splitTelegramText("hello")).toEqual(["hello"]);
  expect(splitTelegramText("")).toEqual([""]);
});

test("long prose splits at paragraph boundaries under the soft cap and loses nothing", () => {
  const text = Array.from({ length: 40 }, (_, i) => para(i)).join("\n\n");
  const chunks = splitTelegramText(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(TELEGRAM_SOFT_LEN);
    expect(c.length).toBeGreaterThan(0);
    expect(c.startsWith("Paragraph")).toBe(true);
  }
  expect(chunks.join("\n\n")).toBe(text);
});

test("text with only single newlines splits at line boundaries", () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ` + "x".repeat(40)).join("\n");
  const chunks = splitTelegramText(text);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_SOFT_LEN);
  expect(chunks.join("\n")).toBe(text);
});

test("unbreakable text gets hard cuts at the soft cap", () => {
  const text = "a".repeat(9000);
  const chunks = splitTelegramText(text);
  expect(chunks.map((c) => c.length)).toEqual([3500, 3500, 2000]);
  expect(chunks.join("")).toBe(text);
});

test("a code fence straddling a cut is closed and reopened with its language", () => {
  const head = "Intro text\n\n";
  const code =
    "```python\n" +
    Array.from({ length: 200 }, (_, i) => `print(${i})  # ${"#".repeat(20)}`).join("\n") +
    "\n```\n\nAfter.";
  const chunks = splitTelegramText(head + code);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0].endsWith("```")).toBe(true);
  expect(chunks[1].startsWith("```python\n")).toBe(true);
  for (const c of chunks) {
    expect((c.match(/```/g) ?? []).length % 2).toBe(0);
    expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_LEN);
  }
});

test("renderTelegramChunks renders each chunk to balanced HTML and strips react directives", () => {
  const text = "[react:👍] **bold** and `code`\n\n```\n" + "x".repeat(5000) + "\n```";
  const chunks = renderTelegramChunks(text);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0].plain).not.toContain("[react:");
  expect(chunks[0].html).toContain("<b>bold</b>");
  for (const c of chunks) {
    expect((c.html.match(/<pre>/g) ?? []).length).toBe((c.html.match(/<\/pre>/g) ?? []).length);
    expect(c.plain.length).toBeLessThanOrEqual(TELEGRAM_MAX_LEN);
  }
});

test("markdownToTelegramHtml escapes HTML and converts the basics", () => {
  expect(markdownToTelegramHtml("a < b & **c**")).toBe("a &lt; b &amp; <b>c</b>");
  expect(markdownToTelegramHtml("- item")).toBe("• item");
  expect(markdownToTelegramHtml("`x<y`")).toBe("<code>x&lt;y</code>");
});
