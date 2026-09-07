// Final-reply delivery for Telegram: chunked sends, and the "edit the streaming preview"
// path that falls back to a fresh message whenever the edit fails for a real reason.
//
// Before this module, the run-finish edit swallowed every failure on the assumption that
// it meant "message is not modified". A dropped connection at that moment left the user
// with whatever the last 500 ms streaming edit contained — a reply frozen mid-word — and
// nothing was ever resent or logged. Replies over 4096 characters lost their tail the same
// silent way.

import { TelegramApiError } from "./telegramApi";
import { renderTelegramChunks, type TelegramChunk } from "./telegramText";

/** A Bot API call bound to a token: (method, body, options) → parsed response. */
export type TelegramApiCall = <T = unknown>(
  method: string,
  body: Record<string, unknown>,
  options?: { retries?: number }
) => Promise<T>;

export type StreamingMode = "edit" | "draft" | "off";

/** Telegram-native drafts (sendMessageDraft) exist for private chats only; groups keep the edit preview. */
export function resolveStreamingMode(setting: string | undefined, isPrivate: boolean): StreamingMode {
  if (setting === "off") return "off";
  if (setting === "draft") return isPrivate ? "draft" : "edit";
  return "edit";
}

/** Shown in place of a streaming preview that could not be edited into the final reply. */
export const STALLED_PREVIEW_NOTE = "⤵️ Connection hiccup mid-reply — the full reply is below.";

/** Send each chunk as HTML, falling back to plain text when Telegram rejects the entities. */
export async function sendChunks(
  api: TelegramApiCall,
  chatId: number,
  threadId: number | undefined,
  chunks: TelegramChunk[],
  retries: number,
  extra?: (isLast: boolean) => Record<string, unknown>
): Promise<void> {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const base = {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      ...(extra ? extra(i === chunks.length - 1) : {}),
    };
    try {
      await api("sendMessage", { ...base, text: chunk.html, parse_mode: "HTML" }, { retries });
    } catch (err) {
      // A 400 means Telegram understood the request and refused the payload (almost always
      // an HTML entity it can't parse); the plain-text variant of the same chunk goes through.
      // Anything else (network, 5xx after retries, 403) is not fixed by re-sending as plain.
      if (err instanceof TelegramApiError && err.status === 400 && !err.isNotModified) {
        await api("sendMessage", { ...base, text: chunk.plain }, { retries });
      } else {
        throw err;
      }
    }
  }
}

async function editWithFallback(
  api: TelegramApiCall,
  chatId: number,
  messageId: number,
  chunk: TelegramChunk,
  retries: number
): Promise<void> {
  const base = { chat_id: chatId, message_id: messageId };
  try {
    await api("editMessageText", { ...base, text: chunk.html, parse_mode: "HTML" }, { retries });
  } catch (err) {
    if (err instanceof TelegramApiError && err.status === 400 && !err.isNotModified) {
      await api("editMessageText", { ...base, text: chunk.plain }, { retries });
    } else {
      throw err;
    }
  }
}

export interface DeliverOptions {
  api: TelegramApiCall;
  chatId: number;
  threadId?: number;
  /** message_id of the streaming preview to edit, or null when nothing was streamed (or drafts were used). */
  streamMsgId: number | null;
  text: string;
  log?: (line: string) => void;
  /** Retries per API call for network/5xx failures. Default 2. */
  retries?: number;
}

export type DeliverOutcome = "edited" | "sent" | "resent";

/**
 * Deliver the final reply.
 * - No preview message: send the reply as one or more fresh messages.
 * - Preview message: edit it into the first chunk, send any further chunks as new messages.
 *   "message is not modified" counts as success (the preview already shows the text). Any other
 *   failure — after the transport's own retries — sends the WHOLE reply as fresh messages and
 *   marks the stalled preview, so a dropped connection never leaves a half-reply on screen.
 */
export async function deliverFinalReply(options: DeliverOptions): Promise<DeliverOutcome> {
  const { api, chatId, threadId, streamMsgId, text, log = () => {}, retries = 2 } = options;
  const chunks = renderTelegramChunks(text);

  if (streamMsgId === null) {
    await sendChunks(api, chatId, threadId, chunks, retries);
    return "sent";
  }

  let edited = false;
  try {
    await editWithFallback(api, chatId, streamMsgId, chunks[0], retries);
    edited = true;
  } catch (err) {
    if (err instanceof TelegramApiError && err.isNotModified) {
      edited = true;
    } else {
      log(
        `[Telegram] Final edit of message ${streamMsgId} in chat ${chatId} failed (${err instanceof Error ? err.message : err}); sending the reply as a new message`
      );
    }
  }

  if (!edited) {
    await sendChunks(api, chatId, threadId, chunks, retries);
    // Best effort: replace the frozen preview with a pointer. If the network is still down this
    // fails too, which is fine — the full reply above is what matters.
    api("editMessageText", { chat_id: chatId, message_id: streamMsgId, text: STALLED_PREVIEW_NOTE }, { retries: 0 }).catch(
      () => {}
    );
    return "resent";
  }

  if (chunks.length > 1) await sendChunks(api, chatId, threadId, chunks.slice(1), retries);
  return "edited";
}
