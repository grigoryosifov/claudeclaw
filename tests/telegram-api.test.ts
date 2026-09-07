import { test, expect } from "bun:test";
import { callApi, TelegramApiError } from "../src/telegramApi";

type Step = { status: number; body?: unknown; throw?: Error };

/** Scripted fetch: one entry per call, in order. */
function fakeFetch(steps: Step[]) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const step = steps.shift();
    if (!step) throw new Error("fakeFetch: no more scripted responses");
    if (step.throw) throw step.throw;
    return new Response(JSON.stringify(step.body ?? { ok: step.status < 400 }), {
      status: step.status,
      statusText: step.status === 200 ? "OK" : "Error",
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

test("returns the parsed body on success", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { ok: true, result: { message_id: 7 } } }]);
  const res = await callApi<{ ok: boolean; result: { message_id: number } }>(
    "tok",
    "sendMessage",
    { chat_id: 1, text: "hi" },
    { fetchImpl, sleep }
  );
  expect(res.result.message_id).toBe(7);
  expect(calls[0].url).toBe("https://api.telegram.org/bottok/sendMessage");
  expect(calls[0].body).toEqual({ chat_id: 1, text: "hi" });
});

test("429 waits retry_after once and retries, even with the default retries: 0", async () => {
  sleeps.length = 0;
  const { fetchImpl, calls } = fakeFetch([
    {
      status: 429,
      body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 2", parameters: { retry_after: 2 } },
    },
    { status: 200, body: { ok: true, result: true } },
  ]);
  await callApi("tok", "editMessageText", { chat_id: 1 }, { fetchImpl, sleep });
  expect(calls.length).toBe(2);
  expect(sleeps).toEqual([2000]);
});

test("a second 429 in a row is not waited for again without a retry budget", async () => {
  sleeps.length = 0;
  const flood = {
    status: 429,
    body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } },
  };
  const { fetchImpl, calls } = fakeFetch([flood, flood]);
  const err = await callApi("tok", "sendMessage", { chat_id: 1 }, { fetchImpl, sleep }).catch((e) => e);
  expect(err).toBeInstanceOf(TelegramApiError);
  expect((err as TelegramApiError).status).toBe(429);
  expect((err as TelegramApiError).retryAfter).toBe(1);
  expect(calls.length).toBe(2);
  expect(sleeps).toEqual([1000]);
});

test("5xx retries with backoff up to `retries`, then throws a typed error", async () => {
  sleeps.length = 0;
  const { fetchImpl, calls } = fakeFetch([{ status: 502 }, { status: 502 }, { status: 502 }]);
  const err = await callApi("tok", "sendMessage", { chat_id: 1 }, { retries: 2, fetchImpl, sleep }).catch((e) => e);
  expect(err).toBeInstanceOf(TelegramApiError);
  expect((err as TelegramApiError).status).toBe(502);
  expect((err as TelegramApiError).isRetryable).toBe(true);
  expect(calls.length).toBe(3);
  expect(sleeps).toEqual([1000, 3000]);
});

test("network failures count as retryable status 0 and succeed on a later attempt", async () => {
  sleeps.length = 0;
  const { fetchImpl, calls } = fakeFetch([
    { status: 0, throw: new Error("Unable to connect. Is the computer able to access the url?") },
    { status: 200, body: { ok: true, result: true } },
  ]);
  await callApi("tok", "sendMessage", { chat_id: 1 }, { retries: 1, fetchImpl, sleep });
  expect(calls.length).toBe(2);
  expect(sleeps).toEqual([1000]);
});

test("with the default retries: 0 a 502 throws immediately (the poll loop keeps its own retry)", async () => {
  sleeps.length = 0;
  const { fetchImpl, calls } = fakeFetch([{ status: 502 }]);
  await expect(callApi("tok", "getUpdates", { timeout: 30 }, { fetchImpl, sleep })).rejects.toBeInstanceOf(TelegramApiError);
  expect(calls.length).toBe(1);
  expect(sleeps).toEqual([]);
});

test("400 'message is not modified' is classified and never retried", async () => {
  sleeps.length = 0;
  const { fetchImpl, calls } = fakeFetch([
    {
      status: 400,
      body: {
        ok: false,
        error_code: 400,
        description:
          "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      },
    },
  ]);
  const err = await callApi("tok", "editMessageText", { chat_id: 1 }, { retries: 2, fetchImpl, sleep }).catch((e) => e);
  const e = err as TelegramApiError;
  expect(e.isNotModified).toBe(true);
  expect(e.isParseError).toBe(false);
  expect(e.isRetryable).toBe(false);
  expect(e.message).toContain("editMessageText: 400");
  expect(calls.length).toBe(1);
  expect(sleeps).toEqual([]);
});

test("400 entity parse errors are classified", async () => {
  const { fetchImpl } = fakeFetch([
    { status: 400, body: { ok: false, description: "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 3" } },
  ]);
  const err = await callApi("tok", "sendMessage", { chat_id: 1 }, { fetchImpl, sleep }).catch((e) => e);
  expect((err as TelegramApiError).isParseError).toBe(true);
});

test("non-JSON error bodies fall back to the HTTP status text", async () => {
  const fetchImpl = (async () =>
    new Response("<html>gateway</html>", { status: 502, statusText: "Bad Gateway" })) as unknown as typeof fetch;
  const err = await callApi("tok", "sendMessage", { chat_id: 1 }, { fetchImpl, sleep }).catch((e) => e);
  expect((err as TelegramApiError).description).toBe("Bad Gateway");
  expect((err as TelegramApiError).message).toBe("Telegram API sendMessage: 502 Bad Gateway");
});
