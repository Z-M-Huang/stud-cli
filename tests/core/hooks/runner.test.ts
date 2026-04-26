import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";

import { Cancellation } from "../../../src/core/errors/cancellation.js";
import {
  orderHooksForSlot,
  runHooksForSlot,
  type GuardVerdict,
  type HookHandle,
  type TransformOutput,
} from "../../../src/core/hooks/runner.js";
import { stubBus } from "../../helpers/context-fixtures.js";

const guard = (id: string, decision: "allow" | "deny", reason?: string): HookHandle => ({
  extensionId: id,
  slot: "TOOL_CALL/pre",
  subKind: "guard",
  fn: () => Promise.resolve({ decision, ...(reason === undefined ? {} : { reason }) }),
});

const transform = (id: string, mutate: (payload: unknown) => unknown): HookHandle => ({
  extensionId: id,
  slot: "TOOL_CALL/pre",
  subKind: "transform",
  fn: ({ payload }) => Promise.resolve({ payload: mutate(payload) }),
});

const observer = (id: string, spy: () => void): HookHandle => ({
  extensionId: id,
  slot: "TOOL_CALL/pre",
  subKind: "observer",
  fn: () => {
    spy();
    return Promise.resolve();
  },
});

const rejectGuard = (error: Error): HookHandle["fn"] => {
  return () => Promise.reject<GuardVerdict>(error);
};

const rejectTransform = (error: Error): HookHandle["fn"] => {
  return () => Promise.reject<TransformOutput>(error);
};

const rejectObserver = (error: Error): HookHandle["fn"] => {
  return () => Promise.reject<void>(error);
};

const orderingCoverageSlots = [
  "RECEIVE_INPUT/pre",
  "RECEIVE_INPUT/post",
  "COMPOSE_REQUEST/pre",
  "COMPOSE_REQUEST/post",
  "SEND_REQUEST/pre",
  "SEND_REQUEST/post",
  "STREAM_RESPONSE/pre",
  "STREAM_RESPONSE/post",
  "TOOL_CALL/post",
  "RENDER/pre",
  "RENDER/post",
] as const;

type OrderingTestSlot = "TOOL_CALL/pre" | (typeof orderingCoverageSlots)[number];

const slotObservers = (slot: OrderingTestSlot): HookHandle[] => [
  {
    extensionId: "z",
    slot,
    subKind: "observer",
    fn: () => Promise.resolve(),
  },
  {
    extensionId: "a",
    slot,
    subKind: "observer",
    fn: () => Promise.resolve(),
  },
];

const orderFor = (
  hooks: readonly HookHandle[],
  slot: OrderingTestSlot,
  manifestOrder: readonly string[],
): readonly HookHandle[] => {
  return orderHooksForSlot(hooks, { perSlot: { [slot]: manifestOrder }, rewrites: [] }, slot);
};

describe("runHooksForSlot — sub-kind order", () => {
  it("runs guards first, then transforms, then observers", async () => {
    const order: string[] = [];
    const g: HookHandle = {
      extensionId: "g",
      slot: "TOOL_CALL/pre",
      subKind: "guard",
      fn: () => {
        order.push("guard");
        return Promise.resolve({ decision: "allow" as const });
      },
    };
    const t = transform("t", (payload) => {
      order.push("transform");
      return payload;
    });
    const o = observer("o", () => order.push("observer"));

    await runHooksForSlot({
      slot: "TOOL_CALL/pre",
      payload: {},
      hooks: [o, t, g],
      ordering: { perSlot: {}, rewrites: [] },
      correlationId: "c",
      eventBus: stubBus(),
    });

    assert.deepEqual(order, ["guard", "transform", "observer"]);
  });

  it("orders hooks within each sub-kind using manifest then lexicographic tie-break", async () => {
    const order: string[] = [];

    await runHooksForSlot({
      slot: "TOOL_CALL/pre",
      payload: {},
      hooks: [
        guard("z-guard", "allow"),
        guard("a-guard", "allow"),
        transform("b-transform", (payload) => {
          order.push("b-transform");
          return payload;
        }),
        transform("a-transform", (payload) => {
          order.push("a-transform");
          return payload;
        }),
        observer("b-observer", () => order.push("b-observer")),
        observer("a-observer", () => order.push("a-observer")),
      ],
      ordering: {
        perSlot: {
          "TOOL_CALL/pre": ["z-guard", "b-transform", "b-observer"],
        },
        rewrites: [],
      },
      correlationId: "c",
      eventBus: stubBus(),
    });

    assert.deepEqual(order, ["b-transform", "a-transform", "b-observer", "a-observer"]);
  });
});

describe("runHooksForSlot — guard denial short-circuits", () => {
  it("first deny stops all subsequent hooks", async () => {
    let transformRan = false;

    const out = await runHooksForSlot({
      slot: "TOOL_CALL/pre",
      payload: {},
      hooks: [
        guard("allow", "allow"),
        guard("deny", "deny", "nope"),
        transform("t", (payload) => {
          transformRan = true;
          return payload;
        }),
      ],
      ordering: { perSlot: {}, rewrites: [] },
      correlationId: "c",
      eventBus: stubBus(),
    });

    assert.equal(out.denied, true);
    assert.equal(out.denyReason, "nope");
    assert.equal(out.denyingExtId, "deny");
    assert.equal(transformRan, false);
  });
});

describe("runHooksForSlot — transforms pipeline", () => {
  it("each transform sees the previous transform's output", async () => {
    const out = await runHooksForSlot({
      slot: "TOOL_CALL/pre",
      payload: { n: 1 },
      hooks: [
        transform("a", (payload: unknown) => ({ n: (payload as { n: number }).n + 1 })),
        transform("b", (payload: unknown) => ({ n: (payload as { n: number }).n * 10 })),
      ],
      ordering: { perSlot: { "TOOL_CALL/pre": ["a", "b"] }, rewrites: [] },
      correlationId: "c",
      eventBus: stubBus(),
    });

    assert.equal((out.payload as { n: number }).n, 20);
  });

  it("transform throw → ExtensionHost/HookTransformFailed", async () => {
    const promise = runHooksForSlot({
      slot: "TOOL_CALL/pre",
      payload: {},
      hooks: [
        {
          extensionId: "t",
          slot: "TOOL_CALL/pre",
          subKind: "transform",
          fn: rejectTransform(new Error("boom")),
        },
      ],
      ordering: { perSlot: {}, rewrites: [] },
      correlationId: "c",
      eventBus: stubBus(),
    });

    await assert.rejects(promise, {
      class: "ExtensionHost",
      context: { code: "HookTransformFailed" },
    });
  });
});

describe("runHooksForSlot — observers are best-effort", () => {
  it("observer throw → HookObserverFailed event, not an error", async () => {
    const bus = stubBus();

    const out = await runHooksForSlot({
      slot: "TOOL_CALL/pre",
      payload: {},
      hooks: [
        {
          extensionId: "o",
          slot: "TOOL_CALL/pre",
          subKind: "observer",
          fn: rejectObserver(new Error("boom")),
        },
      ],
      ordering: { perSlot: {}, rewrites: [] },
      correlationId: "c",
      eventBus: bus,
    });

    assert.equal(out.denied, false);
    assert.ok(bus.events.some((event) => event.name === "HookObserverFailed"));
  });

  it("observers run concurrently after transforms complete", async () => {
    const order: string[] = [];
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });

    const outPromise = runHooksForSlot({
      slot: "TOOL_CALL/pre",
      payload: {},
      hooks: [
        transform("t", (payload) => {
          order.push("transform");
          return payload;
        }),
        {
          extensionId: "a",
          slot: "TOOL_CALL/pre",
          subKind: "observer",
          fn: () => {
            order.push("observer-a:start");
            return wait.then<void>(() => {
              order.push("observer-a:end");
            });
          },
        },
        {
          extensionId: "b",
          slot: "TOOL_CALL/pre",
          subKind: "observer",
          fn: () => {
            order.push("observer-b:start");
            return Promise.resolve();
          },
        },
      ],
      ordering: { perSlot: {}, rewrites: [] },
      correlationId: "c",
      eventBus: stubBus(),
    });

    await setImmediate();
    assert.deepEqual(order, ["transform", "observer-a:start", "observer-b:start"]);

    release();
    const out = await outPromise;

    assert.equal(out.denied, false);
    assert.deepEqual(order, [
      "transform",
      "observer-a:start",
      "observer-b:start",
      "observer-a:end",
    ]);
  });
});

describe("orderHooksForSlot", () => {
  it("manifest order first, then lexicographic for unnamed hooks", () => {
    const hooks = [
      transform("z", (payload) => payload),
      transform("a", (payload) => payload),
      transform("m", (payload) => payload),
    ];

    const ordered = orderFor(hooks, "TOOL_CALL/pre", ["m"]);

    assert.deepEqual(
      ordered.map((hook) => hook.extensionId),
      ["m", "a", "z"],
    );
  });

  it("pure lexicographic when manifest silent for slot", () => {
    const hooks = [transform("z", (payload) => payload), transform("a", (payload) => payload)];

    const ordered = orderHooksForSlot(hooks, { perSlot: {}, rewrites: [] }, "TOOL_CALL/pre");

    assert.deepEqual(
      ordered.map((hook) => hook.extensionId),
      ["a", "z"],
    );
  });

  it("keeps manifest-named hooks in manifest order when both sides are named", () => {
    const hooks = [transform("z", (payload) => payload), transform("a", (payload) => payload)];

    const ordered = orderFor(hooks, "TOOL_CALL/pre", ["a", "z"]);

    assert.deepEqual(
      ordered.map((hook) => hook.extensionId),
      ["a", "z"],
    );
  });

  it("places a manifest-named hook before an unnamed hook", () => {
    const hooks = [transform("z", (payload) => payload), transform("a", (payload) => payload)];

    const ordered = orderFor(hooks, "TOOL_CALL/pre", ["z"]);

    assert.deepEqual(
      ordered.map((hook) => hook.extensionId),
      ["z", "a"],
    );
  });

  it("keeps a manifest-named hook ahead even when the unnamed hook sorts first lexicographically", () => {
    const hooks = [transform("a", (payload) => payload), transform("z", (payload) => payload)];

    const ordered = orderFor(hooks, "TOOL_CALL/pre", ["z"]);

    assert.deepEqual(
      ordered.map((hook) => hook.extensionId),
      ["z", "a"],
    );
  });

  it("filters out hooks attached to other slots", () => {
    const hooks: HookHandle[] = [
      transform("tool", (payload) => payload),
      {
        extensionId: "render",
        slot: "RENDER/pre",
        subKind: "transform",
        fn: ({ payload }) => Promise.resolve({ payload }),
      },
    ];

    const ordered = orderFor(hooks, "TOOL_CALL/pre", ["render", "tool"]);

    assert.deepEqual(
      ordered.map((hook) => `${hook.slot}:${hook.extensionId}`),
      ["TOOL_CALL/pre:tool"],
    );
  });

  for (const slot of orderingCoverageSlots) {
    it(`uses per-slot manifest ordering for ${slot}`, () => {
      const ordered = orderFor(slotObservers(slot), slot, ["z"]);

      assert.deepEqual(
        ordered.map((hook) => hook.extensionId),
        ["z", "a"],
      );
    });

    it(`falls back to lexicographic ordering when manifest is silent for ${slot}`, () => {
      const ordered = orderHooksForSlot(slotObservers(slot), { perSlot: {}, rewrites: [] }, slot);

      assert.deepEqual(
        ordered.map((hook) => hook.extensionId),
        ["a", "z"],
      );
    });
  }
});

describe("runHooksForSlot — guard throw vs. guard deny", () => {
  it("guard throw → ExtensionHost/HookGuardFailed", async () => {
    const promise = runHooksForSlot({
      slot: "TOOL_CALL/pre",
      payload: {},
      hooks: [
        {
          extensionId: "g",
          slot: "TOOL_CALL/pre",
          subKind: "guard",
          fn: rejectGuard(new Error("upstream")),
        },
      ],
      ordering: { perSlot: {}, rewrites: [] },
      correlationId: "c",
      eventBus: stubBus(),
    });

    await assert.rejects(promise, {
      class: "ExtensionHost",
      context: { code: "HookGuardFailed" },
    });
  });

  it("guard deny → HookGuardDenied event emitted", async () => {
    const bus = stubBus();

    await runHooksForSlot({
      slot: "TOOL_CALL/pre",
      payload: {},
      hooks: [guard("g", "deny", "no")],
      ordering: { perSlot: {}, rewrites: [] },
      correlationId: "c",
      eventBus: bus,
    });

    assert.ok(bus.events.some((event) => event.name === "HookGuardDenied"));
  });
});

describe("runHooksForSlot — events and cancellation", () => {
  it("emits HookFired for successful guard, transform, and observer invocations", async () => {
    const bus = stubBus();

    await runHooksForSlot({
      slot: "TOOL_CALL/pre",
      payload: {},
      hooks: [
        guard("g", "allow"),
        transform("t", (payload) => payload),
        observer("o", () => {
          assert.ok(true);
        }),
      ],
      ordering: { perSlot: {}, rewrites: [] },
      correlationId: "c",
      eventBus: bus,
    });

    const fired = bus.events.filter((event) => event.name === "HookFired");
    assert.equal(fired.length, 3);
    assert.deepEqual(
      fired.map((event) => (event.payload as { extensionId: string }).extensionId),
      ["g", "t", "o"],
    );
  });

  it("Cancellation/TurnCancelled propagates from an observer", async () => {
    const promise = runHooksForSlot({
      slot: "TOOL_CALL/pre",
      payload: {},
      hooks: [
        {
          extensionId: "o",
          slot: "TOOL_CALL/pre",
          subKind: "observer",
          fn: rejectObserver(new Cancellation("cancelled", undefined, { code: "TurnCancelled" })),
        },
      ],
      ordering: { perSlot: {}, rewrites: [] },
      correlationId: "c",
      eventBus: stubBus(),
    });

    await assert.rejects(promise, {
      class: "Cancellation",
      context: { code: "TurnCancelled" },
    });
  });
});
