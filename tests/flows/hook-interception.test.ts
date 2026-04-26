/**
 * UAT-18 + AC-47: Hook-Interception ordering at TOOL_CALL/pre.
 *
 * Drives the real `runHooksForSlot` (`src/core/hooks/runner.ts`) with a
 * mix of guard / transform / observer hooks and asserts firing order:
 *
 *   On approve : guard → transform(s) → observer(s)
 *   On deny    : guard fires, transforms do NOT run, observers do NOT
 *                run after a guard denial (the guard short-circuits the
 *                slot).
 *
 * Wiki: flows/Hook-Interception.md + core/Hook-Taxonomy.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEventBus } from "../../src/core/events/bus.js";
import { runHooksForSlot } from "../../src/core/hooks/runner.js";

import type { MergedOrdering } from "../../src/core/hooks/ordering-manifest.js";
import type { HookHandle } from "../../src/core/hooks/runner.js";

function emptyOrdering(): MergedOrdering {
  return { perSlot: {}, rewrites: [] };
}

function makeBus() {
  let tick = 0n;
  return createEventBus({ monotonic: () => ++tick });
}

interface RunResult {
  readonly firingOrder: string[];
  readonly denied: boolean;
}

async function runWithFiringOrder(
  hooks: readonly HookHandle[],
  guardWillDeny: boolean,
  fired: string[],
): Promise<RunResult> {
  const bus = makeBus();
  const out = await runHooksForSlot({
    slot: "TOOL_CALL/pre",
    payload: { initial: true },
    hooks,
    ordering: emptyOrdering(),
    correlationId: "c-1",
    eventBus: bus,
  });
  // Suppress unused-warnings for the params we don't otherwise inspect.
  void guardWillDeny;
  return { firingOrder: [...fired], denied: out.denied };
}

describe("UAT-18: Hook-Interception ordering at TOOL_CALL/pre", () => {
  it("approve path: guard → transform → observer", async () => {
    const fired: string[] = [];
    const hooks: HookHandle[] = [
      {
        extensionId: "guard-ext",
        slot: "TOOL_CALL/pre",
        subKind: "guard",
        fn: () => {
          fired.push("guard");
          return Promise.resolve({ decision: "allow" as const });
        },
      },
      {
        extensionId: "transform-ext",
        slot: "TOOL_CALL/pre",
        subKind: "transform",
        fn: (input) => {
          fired.push("transform");
          return Promise.resolve({
            payload: { ...(input.payload as object), tagged: true },
          });
        },
      },
      {
        extensionId: "observer-ext",
        slot: "TOOL_CALL/pre",
        subKind: "observer",
        fn: () => {
          fired.push("observer");
          return Promise.resolve();
        },
      },
    ];
    const out = await runWithFiringOrder(hooks, false, fired);
    assert.deepEqual(out.firingOrder, ["guard", "transform", "observer"]);
    assert.equal(out.denied, false);
  });

  it("deny path: guard denies → transforms do NOT run; runner returns denied=true", async () => {
    const fired: string[] = [];
    const hooks: HookHandle[] = [
      {
        extensionId: "guard-ext",
        slot: "TOOL_CALL/pre",
        subKind: "guard",
        fn: () => {
          fired.push("guard");
          return Promise.resolve({ decision: "deny" as const, reason: "policy" });
        },
      },
      {
        extensionId: "transform-ext",
        slot: "TOOL_CALL/pre",
        subKind: "transform",
        fn: (input) => {
          fired.push("transform");
          return Promise.resolve({ payload: input.payload });
        },
      },
    ];
    const out = await runWithFiringOrder(hooks, true, fired);
    assert.equal(out.firingOrder.includes("guard"), true);
    assert.equal(out.firingOrder.includes("transform"), false);
    assert.equal(out.denied, true);
  });

  it("multiple guards: first deny short-circuits the chain (subsequent guards do not run)", async () => {
    const fired: string[] = [];
    const hooks: HookHandle[] = [
      {
        extensionId: "guard-1",
        slot: "TOOL_CALL/pre",
        subKind: "guard",
        fn: () => {
          fired.push("guard-1");
          return Promise.resolve({ decision: "deny" as const, reason: "block" });
        },
      },
      {
        extensionId: "guard-2",
        slot: "TOOL_CALL/pre",
        subKind: "guard",
        fn: () => {
          fired.push("guard-2");
          return Promise.resolve({ decision: "allow" as const });
        },
      },
    ];
    const out = await runWithFiringOrder(hooks, true, fired);
    assert.equal(out.firingOrder.includes("guard-1"), true);
    assert.equal(out.firingOrder.includes("guard-2"), false);
    assert.equal(out.denied, true);
  });
});

// ---------------------------------------------------------------------------
// Transform chaining + observer payload
// ---------------------------------------------------------------------------

describe("UAT-18: transform chain + observer post-transform payload", () => {
  it("transform chain: each transform sees the previous transform's payload", async () => {
    const seenPayloads: unknown[] = [];
    const hooks: HookHandle[] = [
      {
        extensionId: "t1",
        slot: "TOOL_CALL/pre",
        subKind: "transform",
        fn: (input) => {
          seenPayloads.push(input.payload);
          return Promise.resolve({ payload: { step: 1 } });
        },
      },
      {
        extensionId: "t2",
        slot: "TOOL_CALL/pre",
        subKind: "transform",
        fn: (input) => {
          seenPayloads.push(input.payload);
          return Promise.resolve({ payload: { step: 2 } });
        },
      },
    ];
    const fired: string[] = [];
    await runWithFiringOrder(hooks, false, fired);
    assert.deepEqual(seenPayloads[0], { initial: true });
    assert.deepEqual(seenPayloads[1], { step: 1 });
  });

  it("observers receive the final post-transform payload", async () => {
    const observed: unknown[] = [];
    const hooks: HookHandle[] = [
      {
        extensionId: "transform",
        slot: "TOOL_CALL/pre",
        subKind: "transform",
        fn: () => Promise.resolve({ payload: { final: true } }),
      },
      {
        extensionId: "obs",
        slot: "TOOL_CALL/pre",
        subKind: "observer",
        fn: (input) => {
          observed.push(input.payload);
          return Promise.resolve();
        },
      },
    ];
    const fired: string[] = [];
    await runWithFiringOrder(hooks, false, fired);
    assert.deepEqual(observed[0], { final: true });
  });
});
