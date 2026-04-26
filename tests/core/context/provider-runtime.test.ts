import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cancellation, ExtensionHost } from "../../../src/core/errors/index.js";

import type { ProviderRegistry } from "../../../src/core/context/provider-registry.ts";
import type {
  ContextFragment,
  ContextProviderHandle,
} from "../../../src/core/context/provider-runtime.ts";

interface ProviderRuntimeModule {
  readonly runProviders: (
    providers: readonly ContextProviderHandle[],
    callContext: { correlationId: string; host: unknown },
    eventBus: { readonly events: readonly { name: string }[] },
  ) => Promise<readonly ContextFragment[]>;
}

interface ProviderRegistryModule {
  readonly createProviderRegistry: () => ProviderRegistry;
}

interface HostFixturesModule {
  readonly fakeHost: () => unknown;
}

interface ContextFixturesModule {
  readonly stubBus: () => { readonly events: readonly { name: string }[] };
}

const { runProviders } = (await import(
  new URL("../../../src/core/context/provider-runtime.ts", import.meta.url).href
)) as ProviderRuntimeModule;
const { createProviderRegistry } = (await import(
  new URL("../../../src/core/context/provider-registry.ts", import.meta.url).href
)) as ProviderRegistryModule;
const { fakeHost } = (await import(
  new URL("../../helpers/host-fixtures.ts", import.meta.url).href
)) as HostFixturesModule;
const { stubBus } = (await import(
  new URL("../../helpers/context-fixtures.ts", import.meta.url).href
)) as ContextFixturesModule;

const handle = (
  id: string,
  graceful: boolean,
  provide: ContextProviderHandle["provide"],
): ContextProviderHandle => ({
  extensionId: id,
  graceful,
  provide,
});

function resolvedFragments(
  fragments: readonly ContextFragment[],
): ContextProviderHandle["provide"] {
  return () => Promise.resolve(fragments);
}

function rejectedProvider(error: Error): ContextProviderHandle["provide"] {
  return () => Promise.reject(error);
}

describe("createProviderRegistry", () => {
  it("registers handles and returns active providers in insertion order", () => {
    const registry = createProviderRegistry();
    const a = handle("a", false, resolvedFragments([]));
    const b = handle("b", true, resolvedFragments([]));

    registry.register(a);
    registry.register(b);

    assert.deepEqual(registry.active(), [a, b]);
  });
});

describe("runProviders — resolution and failures", () => {
  it("happy path — fragments resolved from all providers", async () => {
    const ps = [
      handle(
        "a",
        false,
        resolvedFragments([
          { kind: "system-message", content: "A", priority: 1, budget: 10, ownerExtId: "a" },
        ]),
      ),
      handle(
        "b",
        false,
        resolvedFragments([
          { kind: "tool-hint", content: "B", priority: 1, budget: 10, ownerExtId: "b" },
        ]),
      ),
    ];

    const out = await runProviders(ps, { correlationId: "c", host: fakeHost() }, stubBus());

    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((fragment) => fragment.content),
      ["A", "B"],
    );
    assert.ok(Object.isFrozen(out[0]));
    assert.ok(Object.isFrozen(out[1]));
  });

  it("graceful provider failure → skipped, event emitted", async () => {
    const bus = stubBus();
    const ps = [
      handle("a", true, rejectedProvider(new Error("boom"))),
      handle(
        "b",
        false,
        resolvedFragments([
          { kind: "system-message", content: "B", priority: 1, budget: 10, ownerExtId: "b" },
        ]),
      ),
    ];

    const out = await runProviders(ps, { correlationId: "c", host: fakeHost() }, bus);

    assert.equal(out.length, 1);
    assert.equal(out[0]?.content, "B");
    assert.ok(bus.events.some((event) => event.name === "ContextProviderFailed"));
  });

  it("non-graceful provider failure → ExtensionHost/ContextProviderFailed", async () => {
    const ps = [handle("a", false, rejectedProvider(new Error("boom")))];

    await assert.rejects(runProviders(ps, { correlationId: "c", host: fakeHost() }, stubBus()), {
      class: "ExtensionHost",
      context: { code: "ContextProviderFailed", extensionId: "a" },
    });
  });
});

describe("runProviders — slot conflicts and validation", () => {
  it("preserves exclusiveSlot on frozen fragments", async () => {
    const out = await runProviders(
      [
        handle(
          "a",
          false,
          resolvedFragments([
            {
              kind: "system-message",
              content: "A",
              priority: 1,
              budget: 10,
              ownerExtId: "a",
              exclusiveSlot: "sys",
            },
          ]),
        ),
      ],
      { correlationId: "c", host: fakeHost() },
      stubBus(),
    );

    assert.equal(out[0]?.exclusiveSlot, "sys");
    assert.ok(Object.isFrozen(out[0]));
  });

  it("exclusiveSlot conflict — lexicographic ownerExtId wins", async () => {
    const bus = stubBus();
    const ps = [
      handle(
        "b",
        false,
        resolvedFragments([
          {
            kind: "system-message",
            content: "B",
            priority: 1,
            budget: 10,
            ownerExtId: "b",
            exclusiveSlot: "sys",
          },
        ]),
      ),
      handle(
        "a",
        false,
        resolvedFragments([
          {
            kind: "system-message",
            content: "A",
            priority: 1,
            budget: 10,
            ownerExtId: "a",
            exclusiveSlot: "sys",
          },
        ]),
      ),
    ];

    const out = await runProviders(ps, { correlationId: "c", host: fakeHost() }, bus);

    assert.deepEqual(
      out.map((fragment) => fragment.content),
      ["A"],
    );
    assert.ok(bus.events.some((event) => event.name === "ExclusiveSlotConflict"));
  });

  it("fragment with non-string exclusiveSlot → Validation/FragmentShapeInvalid", async () => {
    const ps = [
      handle(
        "a",
        false,
        resolvedFragments([
          {
            kind: "system-message",
            content: "A",
            priority: 1,
            budget: 10,
            ownerExtId: "a",
            exclusiveSlot: 1,
          } as never,
        ]),
      ),
    ];

    await assert.rejects(runProviders(ps, { correlationId: "c", host: fakeHost() }, stubBus()), {
      class: "Validation",
      context: { code: "FragmentShapeInvalid", ownerExtId: "a" },
    });
  });
});

describe("runProviders — wrapped errors and cancellation", () => {
  it("rethrows a pre-wrapped ExtensionHost/ContextProviderFailed", async () => {
    const original = new ExtensionHost("already wrapped", undefined, {
      code: "ContextProviderFailed",
      extensionId: "a",
    });
    const ps = [handle("a", false, rejectedProvider(original))];

    await assert.rejects(
      runProviders(ps, { correlationId: "c", host: fakeHost() }, stubBus()),
      (error: unknown) => error === original,
    );
  });

  it("fragment missing required field → Validation/FragmentShapeInvalid", async () => {
    const ps = [handle("a", false, resolvedFragments([{ content: "A" } as never]))];

    await assert.rejects(runProviders(ps, { correlationId: "c", host: fakeHost() }, stubBus()), {
      class: "Validation",
      context: { code: "FragmentShapeInvalid", ownerExtId: "a" },
    });
  });

  it("non-turn cancellation propagates unchanged", async () => {
    const original = new Cancellation("tool cancelled", undefined, { code: "ToolCancelled" });
    const ps = [handle("a", false, rejectedProvider(original))];

    await assert.rejects(
      runProviders(ps, { correlationId: "c", host: fakeHost() }, stubBus()),
      (error: unknown) => error === original,
    );
  });

  it("turn cancellation propagates as Cancellation/TurnCancelled", async () => {
    const ps = [
      handle(
        "a",
        false,
        rejectedProvider(new Cancellation("turn cancelled", undefined, { code: "TurnCancelled" })),
      ),
    ];

    await assert.rejects(runProviders(ps, { correlationId: "c", host: fakeHost() }, stubBus()), {
      class: "Cancellation",
      context: { code: "TurnCancelled" },
    });
  });
});
