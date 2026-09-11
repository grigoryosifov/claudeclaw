import { test, expect } from "bun:test";
import { enqueue, laneDepth } from "../src/queue";

/** A task whose completion the test controls. `started` flips the moment the lane invokes it. */
function gate<T>(value: T) {
  let release!: () => void;
  let fail!: (err: Error) => void;
  const done = new Promise<T>((resolve, reject) => {
    release = () => resolve(value);
    fail = reject;
  });
  const state = { started: false, release, fail };
  const fn = () => {
    state.started = true;
    return done;
  };
  return { fn, state };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("main lane runs tasks strictly in arrival order — a task queued behind a running one waits, it is not dropped", async () => {
  const a = gate("a");
  const b = gate("b");
  const pa = enqueue(a.fn);
  const pb = enqueue(b.fn);
  await tick();
  expect(a.state.started).toBe(true);
  expect(b.state.started).toBe(false);
  expect(laneDepth()).toBe(2);

  a.state.release();
  await pa;
  await tick();
  expect(b.state.started).toBe(true);
  expect(laneDepth()).toBe(1);

  b.state.release();
  expect(await pb).toBe("b");
  await tick();
  expect(laneDepth()).toBe(0);
});

test("a failing task surfaces its rejection to its caller and does not block the lane", async () => {
  const bad = gate("x");
  const next = gate("y");
  const pbad = enqueue(bad.fn);
  const pnext = enqueue(next.fn);
  await tick();
  expect(next.state.started).toBe(false);

  bad.state.fail(new Error("boom"));
  await expect(pbad).rejects.toThrow("boom");
  await tick();
  expect(next.state.started).toBe(true);
  next.state.release();
  expect(await pnext).toBe("y");
  await tick();
  expect(laneDepth()).toBe(0);
});

test("thread lanes run in parallel with the main lane and with each other, each with its own depth", async () => {
  const main = gate("main");
  const t1 = gate("t1");
  const t2 = gate("t2");
  const pm = enqueue(main.fn);
  const p1 = enqueue(t1.fn, "topic-1");
  const p2 = enqueue(t2.fn, "topic-2");
  await tick();
  expect(main.state.started).toBe(true);
  expect(t1.state.started).toBe(true);
  expect(t2.state.started).toBe(true);
  expect(laneDepth()).toBe(1);
  expect(laneDepth("topic-1")).toBe(1);
  expect(laneDepth("topic-2")).toBe(1);
  expect(laneDepth("topic-3")).toBe(0);

  const t1b = gate("t1b");
  const p1b = enqueue(t1b.fn, "topic-1");
  await tick();
  expect(t1b.state.started).toBe(false); // same lane → waits
  expect(laneDepth("topic-1")).toBe(2);

  main.state.release();
  t1.state.release();
  t2.state.release();
  await Promise.all([pm, p1, p2]);
  await tick();
  expect(t1b.state.started).toBe(true);
  t1b.state.release();
  await p1b;
  await tick();
  expect(laneDepth("topic-1")).toBe(0);
});
