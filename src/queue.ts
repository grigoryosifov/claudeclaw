/**
 * Serial run lanes for claude subprocesses.
 *
 * The main lane (no threadId) resumes the shared global session, so its tasks must never overlap:
 * two `claude --resume` on one session corrupt it. Per-thread lanes (topics, jobs, agents) are
 * independent — they run in parallel with the main lane and with each other.
 *
 * A task that lands while its lane is busy WAITS its turn; it is never dropped. `laneDepth` tells
 * a caller how many tasks are queued or running ahead, so it can say "queued" instead of going
 * silent (a silent wait reads as "ignored" from the other end of a chat).
 *
 * Each lane's tail is reset to a promise resolving to undefined after every task, so the chain
 * never holds references to previous results (memory leak otherwise).
 */

let mainLane: Promise<unknown> = Promise.resolve();
const threadLanes = new Map<string, Promise<unknown>>();
/** Tasks queued or running per lane, keyed by threadId ("" = main lane). */
const depth = new Map<string, number>();

const MAIN_LANE = "";

function laneKey(threadId?: string): string {
  return threadId ?? MAIN_LANE;
}

/** Number of tasks queued or running on the lane (0 = idle). */
export function laneDepth(threadId?: string): number {
  return depth.get(laneKey(threadId)) ?? 0;
}

/**
 * Run `fn` after everything already on its lane has settled. Returns `fn`'s own promise, so a
 * rejection reaches the caller — and the lane moves on to the next task regardless.
 */
export function enqueue<T>(fn: () => Promise<T>, threadId?: string): Promise<T> {
  const key = laneKey(threadId);
  depth.set(key, (depth.get(key) ?? 0) + 1);
  const settle = () => {
    const left = (depth.get(key) ?? 1) - 1;
    if (left <= 0) depth.delete(key);
    else depth.set(key, left);
  };

  const prev = threadId ? (threadLanes.get(threadId) ?? Promise.resolve()) : mainLane;
  const task = prev.then(fn, fn);
  const tail = task.then(settle, settle);
  if (threadId) threadLanes.set(threadId, tail);
  else mainLane = tail;
  return task;
}
