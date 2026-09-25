import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readBotIdentity, IDENTITY_FILE } from "../src/botIdentity";

function tempPromptsDir(): string {
  return mkdtempSync(join(tmpdir(), "claudeclaw-identity-"));
}

test("no prompts dir → empty identity, no throw", () => {
  const dir = join(tmpdir(), `claudeclaw-identity-missing-${process.pid}-${Date.now()}`);
  expect(readBotIdentity(dir)).toBe("");
});

test("prompts dir without IDENTITY.md → empty identity", () => {
  const dir = tempPromptsDir();
  try {
    expect(readBotIdentity(dir)).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IDENTITY.md content is returned trimmed", () => {
  const dir = tempPromptsDir();
  try {
    writeFileSync(join(dir, IDENTITY_FILE), "\n\n# Sales Agent\n\nYou are the Sales Agent bot.\n\n");
    expect(readBotIdentity(dir)).toBe("# Sales Agent\n\nYou are the Sales Agent bot.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("whitespace-only IDENTITY.md counts as no identity", () => {
  const dir = tempPromptsDir();
  try {
    writeFileSync(join(dir, IDENTITY_FILE), "  \n\t\n");
    expect(readBotIdentity(dir)).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two homes under one cwd resolve to different identities", () => {
  const root = tempPromptsDir();
  try {
    const a = join(root, "social", "prompts");
    const b = join(root, "sales", "prompts");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, IDENTITY_FILE), "You are Social.");
    writeFileSync(join(b, IDENTITY_FILE), "You are Sales.");
    expect(readBotIdentity(a)).toBe("You are Social.");
    expect(readBotIdentity(b)).toBe("You are Sales.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
