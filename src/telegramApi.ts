// Raw Telegram Bot API transport (zero deps): typed errors + flood-control-aware retries.
//
// Every call used to throw a bare `Error("Telegram API <method>: <status> <statusText>")`,
// which made a dropped connection indistinguishable from Telegram's benign
// "message is not modified", and left no way to honor `retry_after` on 429.

export const TELEGRAM_API_BASE = "https://api.telegram.org/bot";

export class TelegramApiError extends Error {
  readonly method: string;
  /** HTTP status of the failed call; 0 when the request never got a response (DNS, timeout, reset). */
  readonly status: number;
  /** Telegram's `description` field when the body was parseable, else the HTTP status text or the network error. */
  readonly description: string;
  /** Seconds Telegram asked us to wait (flood control, HTTP 429). */
  readonly retryAfter?: number;

  constructor(method: string, status: number, description: string, retryAfter?: number) {
    super(`Telegram API ${method}: ${status === 0 ? "network error" : status} ${description}`.trim());
    this.name = "TelegramApiError";
    this.method = method;
    this.status = status;
    this.description = description;
    this.retryAfter = retryAfter;
  }

  /** The request never reached Telegram (or the response never came back). */
  get isNetwork(): boolean {
    return this.status === 0;
  }

  /** editMessageText with content identical to what the message already shows — not a failure. */
  get isNotModified(): boolean {
    return this.status === 400 && /message is not modified/i.test(this.description);
  }

  /** Telegram rejected our HTML entities — the plain-text variant of the same text will go through. */
  get isParseError(): boolean {
    return this.status === 400 && /can't parse entities/i.test(this.description);
  }

  /** Transient by nature: network failure, flood control, or a Telegram-side 5xx. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface CallApiOptions {
  /** Extra attempts after the first for retryable failures (network / 5xx). Default 0 — callers opt in. */
  retries?: number;
  /** Honor `retry_after` on HTTP 429 only when it is at most this many seconds. Default 60. */
  maxRetryAfterSec?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const BACKOFF_MS = [1000, 3000, 6000];

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function errorFromResponse(method: string, res: Response): Promise<TelegramApiError> {
  let description = res.statusText;
  let retryAfter: number | undefined;
  try {
    const data = (await res.json()) as { description?: unknown; parameters?: { retry_after?: unknown } };
    if (typeof data?.description === "string" && data.description) description = data.description;
    const ra = data?.parameters?.retry_after;
    if (typeof ra === "number" && Number.isFinite(ra)) retryAfter = ra;
  } catch {
    // non-JSON error body (proxy/gateway pages) — keep the HTTP status text
  }
  return new TelegramApiError(method, res.status, description, retryAfter);
}

/**
 * POST a Bot API method. Throws `TelegramApiError` on any non-OK response or network failure.
 *
 * Retry policy (bounded, no infinite loops):
 * - HTTP 429 with a sane `retry_after`: wait exactly that long and retry once, even with `retries: 0`.
 * - Network failures / 5xx: retry up to `retries` times with 1s / 3s / 6s backoff.
 * - 4xx (other than 429) is never retried — it will fail the same way again.
 */
export async function callApi<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  options: CallApiOptions = {}
): Promise<T> {
  const { retries = 0, maxRetryAfterSec = 60, fetchImpl = fetch, sleep = defaultSleep } = options;
  // Add 15s buffer on top of Telegram's own long-poll timeout (default 30s)
  const telegramTimeout = (body?.timeout as number | undefined) ?? 0;
  const httpTimeout = Math.max(30_000, (telegramTimeout + 15) * 1000);

  let attempt = 0;
  let floodWaited = false;
  for (;;) {
    let err: TelegramApiError;
    try {
      const res = await fetchImpl(`${TELEGRAM_API_BASE}${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(httpTimeout),
      });
      if (res.ok) return (await res.json()) as T;
      err = await errorFromResponse(method, res);
    } catch (e) {
      err = new TelegramApiError(method, 0, e instanceof Error ? e.message : String(e));
    }

    if (err.status === 429 && !floodWaited && err.retryAfter !== undefined && err.retryAfter <= maxRetryAfterSec) {
      floodWaited = true;
      await sleep(Math.max(1, err.retryAfter) * 1000);
      continue;
    }
    if (err.isRetryable && attempt < retries) {
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      attempt++;
      continue;
    }
    throw err;
  }
}
