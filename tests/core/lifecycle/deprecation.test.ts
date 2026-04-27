import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const deprecationModulePath = "../../../src/core/lifecycle/deprecation.ts";
const { checkDeprecation, loadDeprecationRegistry } = (await import(deprecationModulePath)) as {
  readonly checkDeprecation: (
    extId: string,
    usedField: string,
    coreVersion: string,
    registry: readonly DeprecationEntry[],
  ) => { readonly status: "ok" | "soft" | "hard"; readonly entry?: DeprecationEntry };
  readonly loadDeprecationRegistry: () => readonly DeprecationEntry[];
};

interface DeprecationEntry {
  readonly field: string;
  readonly softSinceVersion: string;
  readonly hardAtVersion: string;
  readonly replacement?: string;
  readonly note?: string;
}

interface TestDeprecationEvent {
  readonly kind: "Deprecation";
  readonly extId: string;
  readonly field: string;
  readonly replacement?: string;
  readonly softSinceVersion: string;
  readonly hardAtVersion: string;
}

interface TestGlobal {
  deprecationSink?: (event: TestDeprecationEvent) => void;
}

describe("checkDeprecation", () => {
  afterEach(() => {
    delete (globalThis as TestGlobal).deprecationSink;
  });

  it("returns ok for a non-deprecated field", () => {
    const events = recordDeprecations();
    const result = checkDeprecation("ext", "validField", "1.0.0", fixtureRegistry());

    assert.equal(result.status, "ok");
    assert.equal(result.entry, undefined);
    assert.deepEqual(events, []);
  });

  it("returns soft and emits a Deprecation event during the soft phase", () => {
    const events = recordDeprecations();
    const result = checkDeprecation("ext", "oldField", "1.1.0", fixtureRegistry());

    assert.equal(result.status, "soft");
    assert.equal(result.entry?.field, "oldField");
    assert.equal(events[0]?.kind, "Deprecation");
    assert.equal(events[0]?.extId, "ext");
    assert.equal(events[0]?.field, "oldField");
    assert.equal(events[0]?.softSinceVersion, "1.1.0");
    assert.equal(events[0]?.hardAtVersion, "2.0.0");
  });

  it("throws Validation/Deprecated at the hard threshold", () => {
    assert.throws(
      () => checkDeprecation("ext", "oldField", "2.0.0", fixtureRegistry()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const err = error as { class?: string; context?: Record<string, unknown> };
        assert.equal(err.class, "Validation");
        assert.equal(err.context?.["code"], "Deprecated");
        assert.equal(err.context?.["field"], "oldField");
        assert.equal(err.context?.["hardAtVersion"], "2.0.0");
        return true;
      },
    );
  });

  it("records replacement metadata in the warning event", () => {
    const events = recordDeprecations();
    checkDeprecation("ext", "oldField", "1.1.0", fixtureRegistry());

    assert.equal(events[0]?.replacement, "newField");
  });

  it("omits replacement metadata when no replacement is declared", () => {
    const events = recordDeprecations();
    checkDeprecation("ext", "legacyOnly", "1.1.1", [
      { field: "legacyOnly", softSinceVersion: "1.1.0", hardAtVersion: "1.1.2" },
    ]);

    assert.equal(events[0]?.replacement, undefined);
  });

  it("throws after the hard threshold, including patch-level comparisons", () => {
    assert.throws(() =>
      checkDeprecation("ext", "patchField", "1.1.3", [
        { field: "patchField", softSinceVersion: "1.1.0", hardAtVersion: "1.1.2" },
      ]),
    );
  });

  it("keeps minor-version soft windows open before hardAtVersion", () => {
    const result = checkDeprecation("ext", "minorField", "1.1.9", [
      { field: "minorField", softSinceVersion: "1.1.0", hardAtVersion: "1.2.0" },
    ]);

    assert.equal(result.status, "soft");
  });

  it("throws after the hard threshold, including major-version comparisons", () => {
    assert.throws(() =>
      checkDeprecation("ext", "majorField", "2.0.0", [
        { field: "majorField", softSinceVersion: "1.1.0", hardAtVersion: "1.2.0" },
      ]),
    );
  });

  it("uses a zero fallback for malformed SemVer inputs", () => {
    const result = checkDeprecation("ext", "malformedVersionField", "", [
      { field: "malformedVersionField", softSinceVersion: "1.1.0", hardAtVersion: "1.0.0" },
    ]);

    assert.equal(result.status, "soft");
  });

  it("loadDeprecationRegistry returns a fresh array each call (no shared mutable state)", () => {
    // Wiki: Deprecation-Policy.md — "Once live, a surface never returns from
    // deprecation silently." No surface has been live in any release yet
    // (v1.0.0 is the first), so the bundled registry is intentionally empty.
    // This test pins the cloning contract on the empty registry; future
    // deprecations populate it after their soft window opens at v1.1.0+.
    const first = loadDeprecationRegistry();
    const second = loadDeprecationRegistry();

    assert.notEqual(first, second, "loadDeprecationRegistry must return a fresh array each call");
    assert.deepEqual(first, [], "no surface has been live in any release; registry is empty");
    assert.deepEqual(second, []);
  });
});

function fixtureRegistry(): readonly DeprecationEntry[] {
  return [
    {
      field: "oldField",
      softSinceVersion: "1.1.0",
      hardAtVersion: "2.0.0",
      replacement: "newField",
    },
  ];
}

function recordDeprecations(): TestDeprecationEvent[] {
  const events: TestDeprecationEvent[] = [];
  (globalThis as TestGlobal).deprecationSink = (event: TestDeprecationEvent): void => {
    events.push(event);
  };
  return events;
}
