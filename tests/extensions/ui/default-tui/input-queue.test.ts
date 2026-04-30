import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInputQueue } from "../../../../src/extensions/ui/default-tui/ink-store.js";

describe("default-tui InputQueue", () => {
  it("delivers a value when the consumer is already waiting", async () => {
    const q = createInputQueue();
    const pending = q.enqueue();
    q.resolveNext("hello");
    assert.equal(await pending, "hello");
  });

  it("buffers a value when no consumer is waiting and delivers it on the next enqueue", async () => {
    const q = createInputQueue();
    // No `enqueue` has been called yet — the value must be buffered, not dropped.
    q.resolveNext("queued");
    const pending = q.enqueue();
    assert.equal(await pending, "queued");
  });

  it("shifts the buffered value so it is consumed exactly once", async () => {
    const q = createInputQueue();
    q.resolveNext("only");
    const first = q.enqueue();
    assert.equal(await first, "only");
    // The next enqueue must NOT receive the same buffered value again.
    let secondResolved = false;
    const second = q.enqueue().then((value) => {
      secondResolved = true;
      return value;
    });
    // Give microtasks a chance to settle.
    await Promise.resolve();
    assert.equal(secondResolved, false);
    q.resolveNext("after");
    assert.equal(await second, "after");
  });

  it("preserves FIFO order across interleaved buffered values and consumers", async () => {
    const q = createInputQueue();
    q.resolveNext("a");
    q.resolveNext("b");
    const first = q.enqueue();
    const second = q.enqueue();
    assert.equal(await first, "a");
    assert.equal(await second, "b");
  });

  it("preserves FIFO order across interleaved consumers and producers", async () => {
    const q = createInputQueue();
    const c1 = q.enqueue();
    const c2 = q.enqueue();
    q.resolveNext("first");
    q.resolveNext("second");
    assert.equal(await c1, "first");
    assert.equal(await c2, "second");
  });

  it("rejectAll rejects every pending awaiter with the given reason", async () => {
    const q = createInputQueue();
    const c1 = q.enqueue();
    const c2 = q.enqueue();
    const reason = new Error("ui unmounted");
    q.rejectAll(reason);
    await assert.rejects(c1, reason);
    await assert.rejects(c2, reason);
  });

  it("rejectAll also clears any buffered values", async () => {
    const q = createInputQueue();
    q.resolveNext("forgotten");
    q.rejectAll(new Error("torn down"));
    // After rejectAll, a new enqueue must wait for a fresh resolveNext —
    // the previously-buffered value is gone.
    let resolved = false;
    const next = q.enqueue().then((value) => {
      resolved = true;
      return value;
    });
    await Promise.resolve();
    assert.equal(resolved, false);
    q.resolveNext("fresh");
    assert.equal(await next, "fresh");
  });
});
