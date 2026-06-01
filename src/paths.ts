import { join, isAbsolute } from "path";

let warnedBadHome = false;

/**
 * Resolve the claudeclaw STATE directory — token, session(s), pid, logs,
 * queue, inbox, whisper, web token, prompts overrides.
 *
 * Default: `<cwd>/.claude/claudeclaw` (original behavior, fully backward
 * compatible). When the `CLAUDECLAW_HOME` env var holds an ABSOLUTE path, that
 * directory is used instead.
 *
 * Why: this decouples a daemon's per-bot state from its working directory, so
 * N daemons can run in parallel against the SAME workspace (same CLAUDE.md +
 * project skills + Claude transcripts) while each keeps its own isolated bot
 * token, session, queue and logs. The workspace/cwd is deliberately NOT
 * affected — the spawned `claude` CLI still runs in `process.cwd()`.
 *
 * A relative `CLAUDECLAW_HOME` is ignored (with a one-time warning) so a
 * mis-set env var can never silently scatter state into an unexpected place.
 */
export function claudeClawDir(): string {
  const override = process.env.CLAUDECLAW_HOME?.trim();
  if (override) {
    if (isAbsolute(override)) return override;
    if (!warnedBadHome) {
      warnedBadHome = true;
      console.error(
        `[claudeclaw] CLAUDECLAW_HOME="${override}" is not absolute — ignoring, using <cwd>/.claude/claudeclaw`,
      );
    }
  }
  return join(process.cwd(), ".claude", "claudeclaw");
}
