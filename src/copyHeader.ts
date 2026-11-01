/**
 * Copy header for the operator's copy of an automation's message.
 *
 * A bot that serves a client sends every automation's output to all allowlisted users: the client
 * and the operator who runs the bot. The operator's copy opens with one line that says it is a copy,
 * whom the original went to and which automation sent it, so a busy operator can skim a day of
 * client traffic from the notification previews alone:
 *
 *   ↪ Copy · sent to Patrick · Monday posting pack
 *
 * Configured per bot in settings.json under telegram.copyHeader:
 *   { "operatorUserIds": [<operator's Telegram id>], "clientName": "Patrick" }
 * With no copyHeader, or when the operator is the only recipient, nothing changes.
 */

export interface CopyHeaderConfig {
  /** Telegram user ids that receive the copy (the operator). */
  operatorUserIds: number[];
  /** The client's first name as it reads in the header ("Patrick", "Joe"). */
  clientName: string;
}

/** Human title for an automation: an explicit title wins, else the job name with dashes as spaces. */
export function automationTitle(name: string, title?: string): string {
  const t = (title ?? "").trim();
  if (t) return t;
  const n = (name ?? "").trim().replace(/[-_]+/g, " ");
  return n || "Automation";
}

/** The header line (with a blank line after it) for this recipient, or "" when none applies. */
export function copyHeaderFor(
  cfg: CopyHeaderConfig | undefined,
  recipientId: number,
  allRecipients: number[],
  title: string,
): string {
  if (!cfg || !cfg.clientName || !Array.isArray(cfg.operatorUserIds)) return "";
  const ops = cfg.operatorUserIds.map(Number);
  if (!ops.includes(Number(recipientId))) return "";
  // Only a copy when somebody else (the client) got the original.
  if (!allRecipients.some((id) => !ops.includes(Number(id)))) return "";
  return `↪ Copy · sent to ${cfg.clientName} · ${title}\n\n`;
}

/** Parse telegram.copyHeader from raw settings; undefined when absent or malformed. */
export function parseCopyHeader(raw: unknown): CopyHeaderConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const ids = Array.isArray(r.operatorUserIds) ? r.operatorUserIds.map(Number).filter((n) => Number.isFinite(n)) : [];
  const name = typeof r.clientName === "string" ? r.clientName.trim() : "";
  if (ids.length === 0 || !name) return undefined;
  return { operatorUserIds: ids, clientName: name };
}
