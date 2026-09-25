import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Per-bot identity for sibling bots that share one workspace.
 *
 * Several daemons can run against the same cwd (one project CLAUDE.md), each with
 * its own CLAUDECLAW_HOME. The project CLAUDE.md is appended to every invocation's
 * system prompt, so on its own it cannot tell the bots apart. A bot that has
 * `<CLAUDECLAW_HOME>/prompts/IDENTITY.md` gets that file appended too — on every
 * invocation (like CLAUDE.md, because --append-system-prompt does not persist
 * across --resume).
 *
 * A missing file means "no identity part" and is never logged: most bots have none.
 */
export const IDENTITY_FILE = "IDENTITY.md";

export function readBotIdentity(promptsDir: string): string {
  const file = join(promptsDir, IDENTITY_FILE);
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] Failed to read bot identity ${file}:`, e);
    return "";
  }
}
