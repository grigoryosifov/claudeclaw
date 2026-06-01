import { describe, test, expect, afterEach } from "bun:test";
import { join, isAbsolute } from "path";
import { tmpdir } from "os";
import { claudeClawDir } from "../paths";

const ORIGINAL_HOME = process.env.CLAUDECLAW_HOME;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.CLAUDECLAW_HOME;
  else process.env.CLAUDECLAW_HOME = ORIGINAL_HOME;
});

describe("claudeClawDir()", () => {
  test("falls back to <cwd>/.claude/claudeclaw when CLAUDECLAW_HOME is unset", () => {
    delete process.env.CLAUDECLAW_HOME;
    expect(claudeClawDir()).toBe(join(process.cwd(), ".claude", "claudeclaw"));
  });

  test("honors an absolute CLAUDECLAW_HOME verbatim", () => {
    const home = join(tmpdir(), "claudeclaw-bot-personal");
    process.env.CLAUDECLAW_HOME = home;
    expect(claudeClawDir()).toBe(home);
  });

  test("two different absolute homes resolve to distinct dirs (parallel-bot isolation)", () => {
    process.env.CLAUDECLAW_HOME = "/tmp/cc-bot-a";
    const a = claudeClawDir();
    process.env.CLAUDECLAW_HOME = "/tmp/cc-bot-b";
    const b = claudeClawDir();
    expect(a).not.toBe(b);
    expect(isAbsolute(a)).toBe(true);
    expect(isAbsolute(b)).toBe(true);
  });

  test("ignores a relative CLAUDECLAW_HOME and falls back to cwd (never scatters state)", () => {
    process.env.CLAUDECLAW_HOME = "relative/path";
    expect(claudeClawDir()).toBe(join(process.cwd(), ".claude", "claudeclaw"));
  });

  test("treats whitespace-only CLAUDECLAW_HOME as unset", () => {
    process.env.CLAUDECLAW_HOME = "   ";
    expect(claudeClawDir()).toBe(join(process.cwd(), ".claude", "claudeclaw"));
  });
});
