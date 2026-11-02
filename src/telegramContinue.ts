// The "▶️ Continue" button on the "⏹ Stopped." message.
//
// A run stopped with the draft's Stop button is often a slip of the thumb: the native Stop sits
// where the composer's send button is while a reply streams. The Stopped message therefore carries
// one button that re-runs the stopped message as if it had been sent again (same chat, thread and
// session, attachments fetched again from Telegram by their file ids). The callback data is only an
// id into a short in-memory map; a daemon restart empties the map, and a tap then answers that
// there is nothing to continue.

import type { TelegramApiCall } from "./telegramDeliver";

export const CONTINUE_PREFIX = "cont:";
export const CONTINUE_LABEL = "▶️ Continue";
export const STOPPED_TEXT = "⏹ Stopped.";
export const NOTHING_TO_CONTINUE = "Nothing to continue — send it again.";
export const CONTINUING = "▶️ Continuing";

/** How long a stopped message can still be continued, and how many are kept per daemon. */
export const CONTINUE_TTL_MS = 24 * 60 * 60 * 1000;
export const CONTINUE_MAX = 50;

interface Entry<M> {
  message: M;
  at: number;
}

export class StoppedStore<M> {
  private entries = new Map<string, Entry<M>>();

  constructor(
    private readonly ttlMs = CONTINUE_TTL_MS,
    private readonly max = CONTINUE_MAX,
    private readonly newId: () => string = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")
  ) {}

  /** Keep a stopped message; returns the id the button carries. */
  remember(message: M, now = Date.now()): string {
    this.prune(now);
    let id = this.newId();
    while (this.entries.has(id)) id = this.newId();
    this.entries.set(id, { message, at: now });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return id;
  }

  /** One-shot: the message behind the id, or null when it is unknown or too old. */
  take(id: string, now = Date.now()): M | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    this.entries.delete(id);
    if (now - entry.at > this.ttlMs) return null;
    return entry.message;
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.at > this.ttlMs) this.entries.delete(id);
    }
  }
}

/** Send "⏹ Stopped." with the Continue button. */
export async function sendStopped(api: TelegramApiCall, chatId: number, threadId: number | undefined, id: string): Promise<void> {
  await api("sendMessage", {
    chat_id: chatId,
    text: STOPPED_TEXT,
    ...(threadId ? { message_thread_id: threadId } : {}),
    reply_markup: { inline_keyboard: [[{ text: CONTINUE_LABEL, callback_data: `${CONTINUE_PREFIX}${id}` }]] },
  });
}

export interface ContinueQuery {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

/**
 * Handle a tap on Continue (the caller has already applied the allowlist). Removes the button from the
 * Stopped message so a second tap does nothing, then re-runs the stopped message or says there is
 * nothing to continue. Returns what happened, for the log.
 */
export async function handleContinueTap<M>(
  api: TelegramApiCall,
  query: ContinueQuery,
  store: StoppedStore<M>,
  rerun: (message: M) => void
): Promise<"continued" | "nothing"> {
  const id = (query.data ?? "").slice(CONTINUE_PREFIX.length);
  if (query.message) {
    await api("editMessageReplyMarkup", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }
  const message = store.take(id);
  if (!message) {
    await api("answerCallbackQuery", { callback_query_id: query.id, text: NOTHING_TO_CONTINUE, show_alert: true }).catch(() => {});
    return "nothing";
  }
  await api("answerCallbackQuery", { callback_query_id: query.id, text: CONTINUING }).catch(() => {});
  rerun(message);
  return "continued";
}
