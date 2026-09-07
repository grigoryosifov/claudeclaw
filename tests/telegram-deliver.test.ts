import { test, expect } from "bun:test";
import {
  deliverFinalReply,
  resolveStreamingMode,
  sendChunks,
  STALLED_PREVIEW_NOTE,
  type TelegramApiCall,
} from "../src/telegramDeliver";
import { TelegramApiError } from "../src/telegramApi";
import { renderTelegramChunks } from "../src/telegramText";

type Call = { method: string; body: Record<string, unknown> };

/** A fake token-bound API; `fail` decides per call whether it throws. */
function fakeApi(fail: (call: Call, n: number) => TelegramApiError | null = () => null) {
  const calls: Call[] = [];
  const api = (async (method: string, body: Record<string, unknown>) => {
    const call = { method, body };
    calls.push(call);
    const err = fail(call, calls.length);
    if (err) throw err;
    return { ok: true, result: { message_id: 100 + calls.length } };
  }) as TelegramApiCall;
  return { api, calls };
}

const notModified = () => new TelegramApiError("editMessageText", 400, "Bad Request: message is not modified");
const network = (m: string) => new TelegramApiError(m, 0, "Unable to connect");
const parseErr = (m: string) => new TelegramApiError(m, 400, "Bad Request: can't parse entities: bad tag");
const logs: string[] = [];
const log = (l: string) => {
  logs.push(l);
};

test("no preview: sends the reply as a fresh HTML message", async () => {
  const { api, calls } = fakeApi();
  const out = await deliverFinalReply({ api, chatId: 5, streamMsgId: null, text: "**hi**", log });
  expect(out).toBe("sent");
  expect(calls.map((c) => c.method)).toEqual(["sendMessage"]);
  expect(calls[0].body).toMatchObject({ chat_id: 5, text: "<b>hi</b>", parse_mode: "HTML" });
});

test("preview + short reply: one edit, no new message", async () => {
  const { api, calls } = fakeApi();
  const out = await deliverFinalReply({ api, chatId: 5, threadId: 9, streamMsgId: 42, text: "done", log });
  expect(out).toBe("edited");
  expect(calls.map((c) => c.method)).toEqual(["editMessageText"]);
  expect(calls[0].body).toMatchObject({ chat_id: 5, message_id: 42, text: "done", parse_mode: "HTML" });
});

test("preview already identical ('not modified') counts as delivered — nothing is resent", async () => {
  const { api, calls } = fakeApi((c) => (c.method === "editMessageText" ? notModified() : null));
  const out = await deliverFinalReply({ api, chatId: 5, streamMsgId: 42, text: "same", log });
  expect(out).toBe("edited");
  expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
});

test("preview edit fails for a real reason: the whole reply is sent fresh and the preview is marked", async () => {
  logs.length = 0;
  const { api, calls } = fakeApi((c) =>
    c.method === "editMessageText" && c.body.text !== STALLED_PREVIEW_NOTE ? network("editMessageText") : null
  );
  const out = await deliverFinalReply({ api, chatId: 5, streamMsgId: 42, text: "Mornin' — full reply here", log });
  expect(out).toBe("resent");
  const sends = calls.filter((c) => c.method === "sendMessage");
  expect(sends).toHaveLength(1);
  expect(sends[0].body.text).toBe("Mornin' - full reply here"); // dashes are normalized on the way out
  const marker = calls.find((c) => c.method === "editMessageText" && c.body.text === STALLED_PREVIEW_NOTE);
  expect(marker?.body).toMatchObject({ chat_id: 5, message_id: 42 });
  expect(logs[0]).toContain("Final edit of message 42");
});

test("preview + long reply: the edit takes chunk 1, the rest arrive as new messages in order", async () => {
  const { api, calls } = fakeApi();
  const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: ` + "word ".repeat(60).trim()).join("\n\n");
  const chunks = renderTelegramChunks(text);
  expect(chunks.length).toBeGreaterThan(2);
  const out = await deliverFinalReply({ api, chatId: 5, streamMsgId: 42, text, log });
  expect(out).toBe("edited");
  expect(calls[0]).toMatchObject({ method: "editMessageText", body: { message_id: 42, text: chunks[0].html } });
  expect(calls.slice(1).map((c) => c.method)).toEqual(chunks.slice(1).map(() => "sendMessage"));
  expect(calls.slice(1).map((c) => c.body.text)).toEqual(chunks.slice(1).map((c) => c.html));
});

test("HTML rejected by Telegram falls back to the plain-text variant of the same chunk", async () => {
  const { api, calls } = fakeApi((c) => (c.body.parse_mode === "HTML" ? parseErr(c.method) : null));
  const out = await deliverFinalReply({ api, chatId: 5, streamMsgId: 42, text: "**bold**", log });
  expect(out).toBe("edited");
  expect(calls.map((c) => [c.method, c.body.parse_mode ?? "plain", c.body.text])).toEqual([
    ["editMessageText", "HTML", "<b>bold</b>"],
    ["editMessageText", "plain", "**bold**"],
  ]);
});

test("sendChunks attaches extras only where asked (buttons on the last chunk)", async () => {
  const { api, calls } = fakeApi();
  const chunks = renderTelegramChunks("a".repeat(5000));
  await sendChunks(api, 5, undefined, chunks, 0, (isLast) => (isLast ? { reply_markup: { inline_keyboard: [] } } : {}));
  expect(calls).toHaveLength(2);
  expect(calls[0].body.reply_markup).toBeUndefined();
  expect(calls[1].body.reply_markup).toEqual({ inline_keyboard: [] });
});

test("sendChunks propagates non-400 failures instead of re-sending as plain text", async () => {
  const { api, calls } = fakeApi((c) => (c.method === "sendMessage" ? network("sendMessage") : null));
  await expect(sendChunks(api, 5, undefined, renderTelegramChunks("x"), 0)).rejects.toBeInstanceOf(TelegramApiError);
  expect(calls).toHaveLength(1);
});

test("resolveStreamingMode: drafts only in private chats, off is always off, everything else edits", () => {
  expect(resolveStreamingMode("draft", true)).toBe("draft");
  expect(resolveStreamingMode("draft", false)).toBe("edit");
  expect(resolveStreamingMode("off", true)).toBe("off");
  expect(resolveStreamingMode("edit", true)).toBe("edit");
  expect(resolveStreamingMode(undefined, false)).toBe("edit");
  expect(resolveStreamingMode("bogus", true)).toBe("edit");
});
