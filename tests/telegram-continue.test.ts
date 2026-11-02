import { test, expect } from "bun:test";
import {
  CONTINUE_LABEL,
  CONTINUE_PREFIX,
  NOTHING_TO_CONTINUE,
  STOPPED_TEXT,
  StoppedStore,
  handleContinueTap,
  sendStopped,
} from "../src/telegramContinue";
import type { TelegramApiCall } from "../src/telegramDeliver";

type Call = { method: string; body: Record<string, unknown> };

function fakeApi() {
  const calls: Call[] = [];
  const api = (async (method: string, body: Record<string, unknown>) => {
    calls.push({ method, body });
    return { ok: true, result: { message_id: 7 } };
  }) as TelegramApiCall;
  return { api, calls };
}

const msg = { message_id: 41, chat: { id: 5 }, text: "make the vortex reel" };

test("Stopped carries one Continue button whose data is a short id, in the stopped message's thread", async () => {
  const { api, calls } = fakeApi();
  await sendStopped(api, 5, 12, "a1b2c3d4");
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe("sendMessage");
  expect(calls[0].body).toMatchObject({
    chat_id: 5,
    text: STOPPED_TEXT,
    message_thread_id: 12,
    reply_markup: { inline_keyboard: [[{ text: CONTINUE_LABEL, callback_data: "cont:a1b2c3d4" }]] },
  });
  expect(String((calls[0].body.reply_markup as any).inline_keyboard[0][0].callback_data).length).toBeLessThanOrEqual(64);
});

test("no thread id: the field is left out", async () => {
  const { api, calls } = fakeApi();
  await sendStopped(api, 5, undefined, "x");
  expect("message_thread_id" in calls[0].body).toBe(false);
});

test("a tap re-runs the stopped message once and removes the button; a second tap finds nothing", async () => {
  const store = new StoppedStore<typeof msg>();
  const id = store.remember(msg);
  const reruns: (typeof msg)[] = [];
  const { api, calls } = fakeApi();
  const query = { id: "q1", data: CONTINUE_PREFIX + id, message: { message_id: 90, chat: { id: 5 } } };

  expect(await handleContinueTap(api, query, store, (m) => reruns.push(m))).toBe("continued");
  expect(reruns).toEqual([msg]);
  expect(calls[0]).toEqual({
    method: "editMessageReplyMarkup",
    body: { chat_id: 5, message_id: 90, reply_markup: { inline_keyboard: [] } },
  });
  expect(calls[1].method).toBe("answerCallbackQuery");

  expect(await handleContinueTap(api, { ...query, id: "q2" }, store, (m) => reruns.push(m))).toBe("nothing");
  expect(reruns).toHaveLength(1);
  expect(calls.at(-1)).toEqual({
    method: "answerCallbackQuery",
    body: { callback_query_id: "q2", text: NOTHING_TO_CONTINUE, show_alert: true },
  });
});

test("an unknown id (daemon restarted) answers that there is nothing to continue", async () => {
  const store = new StoppedStore<typeof msg>();
  const { api, calls } = fakeApi();
  const reruns: unknown[] = [];
  const out = await handleContinueTap(api, { id: "q", data: "cont:deadbeef" }, store, (m) => reruns.push(m));
  expect(out).toBe("nothing");
  expect(reruns).toHaveLength(0);
  expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
});

test("entries expire after the TTL and the store keeps at most max entries", () => {
  let n = 0;
  const store = new StoppedStore<number>(1000, 3, () => `id${n++}`);
  const old = store.remember(1, 0);
  expect(store.take(old, 1001)).toBeNull();
  const ids = [store.remember(1, 2000), store.remember(2, 2000), store.remember(3, 2000), store.remember(4, 2000)];
  expect(store.size).toBe(3);
  expect(store.take(ids[0], 2001)).toBeNull();
  expect(store.take(ids[3], 2001)).toBe(4);
});

test("an id collision draws a new id", () => {
  const seq = ["same", "same", "other"];
  const store = new StoppedStore<number>(1000, 10, () => seq.shift()!);
  expect(store.remember(1, 0)).toBe("same");
  expect(store.remember(2, 0)).toBe("other");
});
