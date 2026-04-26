import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDisposeTracker } from "../../../src/core/lifecycle/disposer.js";
import {
  createLifecycleManager,
  resolveDependencyOrder,
} from "../../../src/core/lifecycle/manager.js";
import {
  emitUnscopedHostPing,
  fakeHost,
  fakeHostWithoutAs,
  stubBus,
} from "../../helpers/context-fixtures.js";

import type { HostAPI } from "../../../src/core/host/host-api.js";

const noop = async (): Promise<void> => {
  await Promise.resolve();
};

const handle = (id: string, deps: string[] = [], fns: Partial<Record<string, unknown>> = {}) => ({
  extensionId: id,
  kind: "Tool" as const,
  lifecycle: fns as never,
  config: {},
  dependsOn: deps,
});
describe("createLifecycleManager — phase order", () => {
  it("runs init → activate → deactivate → dispose exactly once", async () => {
    const order: string[] = [];
    const mgr = createLifecycleManager(fakeHost(), stubBus());

    await mgr.load(
      handle("a", [], {
        init: async () => {
          await Promise.resolve();
          order.push("init");
        },
        activate: async () => {
          await Promise.resolve();
          order.push("activate");
        },
        deactivate: async () => {
          await Promise.resolve();
          order.push("deactivate");
        },
        dispose: async () => {
          await Promise.resolve();
          order.push("dispose");
        },
      }),
    );
    await mgr.activate("a");
    await mgr.deactivate("a");
    await mgr.dispose("a");

    assert.deepEqual(order, ["init", "activate", "deactivate", "dispose"]);
  });
});
describe("createLifecycleManager — dispose idempotency", () => {
  it("second dispose is a no-op", async () => {
    let calls = 0;
    const mgr = createLifecycleManager(fakeHost(), stubBus());
    await mgr.load(
      handle("a", [], {
        init: noop,
        dispose: async () => {
          await Promise.resolve();
          calls += 1;
        },
      }),
    );
    await mgr.dispose("a");
    await mgr.dispose("a");
    assert.equal(calls, 1);
    assert.equal(mgr.state("a"), "disposed");
  });
});
describe("createLifecycleManager — dependency order", () => {
  it("activate waits for dependencies first", async () => {
    const order: string[] = [];
    const mgr = createLifecycleManager(fakeHost(), stubBus());

    await mgr.load(
      handle("a", [], {
        init: noop,
        activate: async () => {
          await Promise.resolve();
          order.push("a");
        },
      }),
    );
    await mgr.load(
      handle("b", ["a"], {
        init: noop,
        activate: async () => {
          await Promise.resolve();
          order.push("b");
        },
      }),
    );
    await mgr.activate("b");

    assert.deepEqual(order, ["a", "b"]);
  });

  it("deactivate runs in reverse dependency order", async () => {
    const order: string[] = [];
    const mgr = createLifecycleManager(fakeHost(), stubBus());

    await mgr.load(
      handle("a", [], {
        init: noop,
        activate: noop,
        deactivate: async () => {
          await Promise.resolve();
          order.push("a");
        },
      }),
    );
    await mgr.load(
      handle("b", ["a"], {
        init: noop,
        activate: noop,
        deactivate: async () => {
          await Promise.resolve();
          order.push("b");
        },
      }),
    );
    await mgr.activate("b");
    await mgr.deactivate("a");

    assert.deepEqual(order, ["b", "a"]);
  });
});
describe("createLifecycleManager — error semantics", () => {
  it("lifecycle throw → ExtensionHost/LifecycleFailure, state preserved", async () => {
    const mgr = createLifecycleManager(fakeHost(), stubBus());
    const h = handle("a", [], {
      init: async () => {
        await Promise.resolve();
        throw new Error("boom");
      },
    });

    await assert.rejects(mgr.load(h), {
      class: "ExtensionHost",
      context: { code: "LifecycleFailure" },
    });
    assert.equal(mgr.state("a"), "unknown");
  });

  it("activate on disposed → ExtensionHost/LifecyclePhaseInvalid", async () => {
    const mgr = createLifecycleManager(fakeHost(), stubBus());

    await mgr.load(handle("a", [], { init: noop, dispose: noop }));
    await mgr.dispose("a");
    await assert.rejects(mgr.activate("a"), {
      class: "ExtensionHost",
      context: { code: "LifecyclePhaseInvalid" },
    });
  });

  it("missing dependency → ExtensionHost/DependencyMissing", async () => {
    const mgr = createLifecycleManager(fakeHost(), stubBus());

    await assert.rejects(mgr.load(handle("b", ["missing"], { init: noop })), {
      class: "ExtensionHost",
      context: { code: "DependencyMissing" },
    });
  });
});
describe("resolveDependencyOrder", () => {
  it("topological order for a DAG", () => {
    const order = resolveDependencyOrder([
      handle("c", ["b"]),
      handle("a"),
      handle("b", ["a"]),
    ] as never);

    assert.ok(order.indexOf("a") < order.indexOf("b"));
    assert.ok(order.indexOf("b") < order.indexOf("c"));
  });

  it("cycle → ExtensionHost/DependencyCycle with cycle path", () => {
    assert.throws(
      () => resolveDependencyOrder([handle("a", ["b"]), handle("b", ["a"])] as never),
      /DependencyCycle/,
    );
  });
});
describe("createLifecycleManager — deactivate leaves subscriptions for dispose", () => {
  it("subscribed events still observable after deactivate; cease after dispose", async () => {
    const bus = stubBus();
    const observed: string[] = [];
    const mgr = createLifecycleManager(fakeHost(), bus);

    await mgr.load(
      handle("a", [], {
        init: async (host: HostAPI) => {
          await Promise.resolve();
          host.events.on("Ping", () => observed.push("init-sub"));
        },
        activate: noop,
        deactivate: noop,
        dispose: noop,
      }),
    );
    await mgr.activate("a");
    await mgr.deactivate("a");
    bus.emit({ name: "Ping", correlationId: "c-1", monotonicTs: 0n, payload: {} });
    assert.equal(observed.length, 1);
    await mgr.dispose("a");
    bus.emit({ name: "Ping", correlationId: "c-2", monotonicTs: 0n, payload: {} });
    assert.equal(observed.length, 1);
  });
});
describe("createLifecycleManager — phase events and states", () => {
  it("emits LifecyclePhaseStart and LifecyclePhaseEnd for each executed phase", async () => {
    const bus = stubBus();
    const mgr = createLifecycleManager(fakeHost(), bus);

    await mgr.load(handle("a", [], { init: noop, activate: noop, dispose: noop }));
    await mgr.activate("a");
    await mgr.dispose("a");

    const phaseEvents = bus.events.filter(
      (event) => event.name === "LifecyclePhaseStart" || event.name === "LifecyclePhaseEnd",
    );
    assert.deepEqual(
      phaseEvents.map((event) => [event.name, (event.payload as { phase: string }).phase]),
      [
        ["LifecyclePhaseStart", "init"],
        ["LifecyclePhaseEnd", "init"],
        ["LifecyclePhaseStart", "activate"],
        ["LifecyclePhaseEnd", "activate"],
        ["LifecyclePhaseStart", "dispose"],
        ["LifecyclePhaseEnd", "dispose"],
      ],
    );
    for (const event of phaseEvents) {
      const payload = event.payload as {
        extensionId: string;
        phase: string;
        durationMs: number;
      };
      assert.equal(payload.extensionId, "a");
      assert.equal(typeof payload.durationMs, "number");
    }
  });

  it("returns inactive after deactivation", async () => {
    const mgr = createLifecycleManager(fakeHost(), stubBus());
    await mgr.load(handle("a", [], { init: noop, activate: noop, deactivate: noop }));
    await mgr.activate("a");
    await mgr.deactivate("a");
    assert.equal(mgr.state("a"), "inactive");
  });

  it("returns loaded after load before activation", async () => {
    const mgr = createLifecycleManager(fakeHost(), stubBus());
    await mgr.load(handle("a", [], { init: noop }));
    assert.equal(mgr.state("a"), "loaded");
  });
});
describe("createLifecycleManager — invalid phase handling", () => {
  it("deactivate on unknown extension throws LifecyclePhaseInvalid", async () => {
    const mgr = createLifecycleManager(fakeHost(), stubBus());
    await assert.rejects(mgr.deactivate("missing"), {
      class: "ExtensionHost",
      context: { code: "LifecyclePhaseInvalid" },
    });
  });

  it("dispose on unknown extension throws LifecyclePhaseInvalid", async () => {
    const mgr = createLifecycleManager(fakeHost(), stubBus());
    await assert.rejects(mgr.dispose("missing"), {
      class: "ExtensionHost",
      context: { code: "LifecyclePhaseInvalid" },
    });
  });
});
describe("createLifecycleManager — disposeAll", () => {
  it("disposes every registered extension in reverse dependency order", async () => {
    const order: string[] = [];
    const mgr = createLifecycleManager(fakeHost(), stubBus());

    await mgr.load(
      handle("a", [], {
        init: noop,
        dispose: async () => {
          await Promise.resolve();
          order.push("a");
        },
      }),
    );
    await mgr.load(
      handle("b", ["a"], {
        init: noop,
        dispose: async () => {
          await Promise.resolve();
          order.push("b");
        },
      }),
    );
    await mgr.disposeAll();

    assert.deepEqual(order, ["b", "a"]);
  });

  it("aggregates dispose failures after attempting all extensions", async () => {
    const calls: string[] = [];
    const mgr = createLifecycleManager(fakeHost(), stubBus());

    await mgr.load(
      handle("a", [], {
        init: noop,
        dispose: async () => {
          await Promise.resolve();
          calls.push("a");
          throw new Error("dispose-a");
        },
      }),
    );
    await mgr.load(
      handle("b", [], {
        init: noop,
        dispose: async () => {
          await Promise.resolve();
          calls.push("b");
        },
      }),
    );

    await assert.rejects(mgr.disposeAll(), {
      class: "ExtensionHost",
      context: { code: "LifecycleFailure" },
    });
    assert.deepEqual(calls.sort(), ["a", "b"]);
    assert.equal(mgr.state("b"), "disposed");
  });
});

async function assertRejectsDuplicateLoad(): Promise<void> {
  const mgr = createLifecycleManager(fakeHost(), stubBus());
  await mgr.load(handle("a", [], { init: noop }));
  await assert.rejects(mgr.load(handle("a", [], { init: noop })), {
    class: "ExtensionHost",
    context: { code: "LifecyclePhaseInvalid" },
  });
}

async function assertActivateUnknownExtension(): Promise<void> {
  const mgr = createLifecycleManager(fakeHost(), stubBus());
  await assert.rejects(mgr.activate("missing"), {
    class: "ExtensionHost",
    context: { code: "LifecyclePhaseInvalid" },
  });
}

async function assertReactivationAndActiveNoop(): Promise<void> {
  const calls: string[] = [];
  const mgr = createLifecycleManager(fakeHost(), stubBus());
  await mgr.load(
    handle("a", [], {
      init: noop,
      activate: async () => {
        await Promise.resolve();
        calls.push("activate");
      },
      deactivate: async () => {
        await Promise.resolve();
        calls.push("deactivate");
      },
    }),
  );
  await mgr.activate("a");
  await mgr.activate("a");
  await mgr.deactivate("a");
  await mgr.activate("a");
  assert.deepEqual(calls, ["activate", "deactivate", "activate"]);
  assert.equal(mgr.state("a"), "active");
}

async function assertDiamondDependencyActivatesOnce(): Promise<void> {
  const calls: string[] = [];
  const mgr = createLifecycleManager(fakeHost(), stubBus());
  await mgr.load(
    handle("a", [], {
      init: noop,
      activate: async () => {
        await Promise.resolve();
        calls.push("a");
      },
    }),
  );
  await mgr.load(handle("b", ["a"], { init: noop, activate: noop }));
  await mgr.load(handle("c", ["a"], { init: noop, activate: noop }));
  await mgr.load(handle("d", ["b", "c"], { init: noop, activate: noop }));
  await mgr.activate("d");
  assert.deepEqual(calls, ["a"]);
}

async function assertFallbackHostWithoutAs(): Promise<void> {
  const observed: string[] = [];
  const slotCalls: string[] = [];
  const emitted: { event: string; payload: unknown }[] = [];
  const host = fakeHostWithoutAs({ slotCalls, emitted });
  const mgr = createLifecycleManager(host, stubBus());
  await mgr.load(
    handle("a", [], {
      init: async (scopedHost: HostAPI) => {
        await Promise.resolve();
        await scopedHost.session.stateSlot("wrong-id").read();
        scopedHost.events.on("Ping", (payload) => observed.push(String(payload)));
        scopedHost.events.emit("Pong", { ok: true });
      },
      dispose: noop,
    }),
  );
  emitUnscopedHostPing(host, "seen");
  assert.deepEqual(observed, ["seen"]);
  assert.deepEqual(slotCalls, ["a"]);
  assert.deepEqual(emitted, [{ event: "Pong", payload: { ok: true } }]);
  await mgr.dispose("a");
  emitUnscopedHostPing(host, "after-dispose");
  assert.deepEqual(observed, ["seen"]);
}

async function assertCascadeDisposeSkipsAlreadyDisposedDependents(): Promise<void> {
  const calls: string[] = [];
  const mgr = createLifecycleManager(fakeHost(), stubBus());
  await mgr.load(
    handle("a", [], {
      init: noop,
      dispose: async () => {
        await Promise.resolve();
        calls.push("a");
      },
    }),
  );
  await mgr.load(
    handle("b", ["a"], {
      init: noop,
      dispose: async () => {
        await Promise.resolve();
        calls.push("b");
      },
    }),
  );
  await mgr.dispose("b");
  await mgr.dispose("a");
  assert.deepEqual(calls, ["b", "a"]);
}

describe("createLifecycleManager — additional manager branches", () => {
  it("rejects duplicate load for the same extension", assertRejectsDuplicateLoad);
  it("activate on unknown extension throws LifecyclePhaseInvalid", assertActivateUnknownExtension);
  it(
    "allows re-activation from inactive state and no-ops when already active",
    assertReactivationAndActiveNoop,
  );
  it(
    "activates a shared dependency only once in a dependency diamond",
    assertDiamondDependencyActivatesOnce,
  );
  it(
    "uses the unscoped host when host.as is unavailable and preserves host adapters",
    assertFallbackHostWithoutAs,
  );
  it(
    "skips already disposed dependents during cascading dispose",
    assertCascadeDisposeSkipsAlreadyDisposedDependents,
  );
});
describe("createDisposeTracker", () => {
  it("tracks disposal state and releases subscriptions in reverse order", () => {
    const tracker = createDisposeTracker();
    const calls: string[] = [];

    tracker.trackSubscription("a", () => calls.push("first"));
    tracker.trackSubscription("a", () => calls.push("second"));
    tracker.releaseSubscriptions("a");
    tracker.markDisposed("a");

    assert.deepEqual(calls, ["second", "first"]);
    assert.equal(tracker.isDisposed("a"), true);
  });

  it("handles release of unknown extension subscriptions as a no-op", () => {
    const tracker = createDisposeTracker();

    tracker.releaseSubscriptions("missing");

    assert.equal(tracker.isDisposed("missing"), false);
  });
});
