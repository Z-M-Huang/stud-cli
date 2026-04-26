import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExtensionHost, Session, Validation } from "../../../src/core/errors/index.js";
import { readSlot, writeSlot } from "../../../src/core/lifecycle/extension-state.js";
import { mockHost } from "../../helpers/mock-host.js";

import type { StateSlotPolicy } from "../../../src/core/lifecycle/extension-state.js";

function runtimeFor(
  extId: string,
  initialState?: Readonly<Record<string, unknown>>,
): {
  readonly runtime: {
    readonly session: ReturnType<typeof mockHost>["host"]["session"];
    readonly audit: ReturnType<typeof mockHost>["host"]["audit"];
  };
  readonly auditRecords: readonly {
    readonly class: string;
    readonly extId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }[];
} {
  const { host, recorders } = mockHost(
    initialState === undefined ? { extId } : { extId, initialState },
  );
  return {
    runtime: { session: host.session, audit: host.audit },
    auditRecords: recorders.audit.records as readonly {
      readonly class: string;
      readonly extId: string;
      readonly payload: Readonly<Record<string, unknown>>;
    }[],
  };
}

function policy<T>(input: {
  readonly currentVersion: string;
  readonly decideDrift?: (stored: {
    readonly slotVersion: string;
    readonly data: unknown;
  }) => "migrate" | "warn" | "reject";
  readonly migrate?: StateSlotPolicy<T>["migrate"];
}): StateSlotPolicy<T> {
  return {
    currentVersion: input.currentVersion,
    decideDrift: input.decideDrift ?? (() => "warn"),
    ...(input.migrate === undefined ? {} : { migrate: input.migrate }),
  };
}

describe("writeSlot/readSlot", () => {
  it("writes through the session slot surface and reads the stored slot unchanged at the current version", async () => {
    const { runtime } = runtimeFor("ext-a");
    await writeSlot("ext-a", { slotVersion: "1.0.0", data: { foo: 1 } }, runtime);

    const stored = await readSlot<{ foo: number }>(
      "ext-a",
      policy<{ foo: number }>({ currentVersion: "1.0.0" }),
      runtime,
    );

    assert.deepEqual(stored, { slotVersion: "1.0.0", data: { foo: 1 } });
  });

  it("returns null when no slot exists", async () => {
    const { runtime } = runtimeFor("ext-a");
    const stored = await readSlot<{ foo: number }>(
      "ext-a",
      policy<{ foo: number }>({ currentVersion: "1.0.0" }),
      runtime,
    );

    assert.equal(stored, null);
  });
});

describe("readSlot drift handling", () => {
  it("throws Validation/SlotVersionMissing on an unversioned slot", async () => {
    const { runtime } = runtimeFor("ext-a", { data: { foo: 1 } });

    await assert.rejects(
      readSlot<{ foo: number }>(
        "ext-a",
        policy<{ foo: number }>({ currentVersion: "1.0.0" }),
        runtime,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.code, "SlotVersionMissing");
        assert.equal(error.context["extId"], "ext-a");
        return true;
      },
    );
  });

  it("returns the stored slot unchanged when the policy decides warn", async () => {
    const { runtime, auditRecords } = runtimeFor("ext-a", {
      slotVersion: "0.9.0",
      data: { foo: 1 },
    });

    const stored = await readSlot<{ foo: number }>(
      "ext-a",
      policy<{ foo: number }>({ currentVersion: "1.0.0", decideDrift: () => "warn" }),
      runtime,
    );

    assert.deepEqual(stored, { slotVersion: "0.9.0", data: { foo: 1 } });
    const driftRecord = auditRecords.find((record) => record.class === "StateSlotDrift");
    assert.ok(driftRecord !== undefined);
    assert.equal(driftRecord.extId, "ext-a");
    assert.equal(driftRecord.payload["decision"], "warn");
  });

  it("migrates a drifted slot when the policy decides migrate", async () => {
    const { runtime, auditRecords } = runtimeFor("ext-a", {
      slotVersion: "1.0.0",
      data: { foo: 1 },
    });

    const stored = await readSlot<{ foo: number; migrated: true }>(
      "ext-a",
      policy<{ foo: number; migrated: true }>({
        currentVersion: "2.0.0",
        decideDrift: () => "migrate",
        migrate: (slot) => ({
          slotVersion: "2.0.0",
          data: { ...(slot.data as { foo: number }), migrated: true },
        }),
      }),
      runtime,
    );

    assert.deepEqual(stored, {
      slotVersion: "2.0.0",
      data: { foo: 1, migrated: true },
    });
    const driftRecord = auditRecords.find((record) => record.class === "StateSlotDrift");
    assert.ok(driftRecord !== undefined);
    assert.equal(driftRecord.payload["decision"], "migrate");
  });

  it("throws Session/SlotDriftRejected when the policy decides reject", async () => {
    const { runtime, auditRecords } = runtimeFor("ext-a", {
      slotVersion: "1.0.0",
      data: { foo: 1 },
    });

    await assert.rejects(
      readSlot<{ foo: number }>(
        "ext-a",
        policy<{ foo: number }>({ currentVersion: "2.0.0", decideDrift: () => "reject" }),
        runtime,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Session);
        assert.equal(error.code, "SlotDriftRejected");
        assert.equal(error.context["extId"], "ext-a");
        assert.equal(error.context["storedVersion"], "1.0.0");
        assert.equal(error.context["expectedVersion"], "2.0.0");
        return true;
      },
    );

    const driftRecord = auditRecords.find((record) => record.class === "StateSlotDrift");
    assert.ok(driftRecord !== undefined);
    assert.equal(driftRecord.payload["decision"], "reject");
  });
});

describe("readSlot access control", () => {
  it("throws ExtensionHost/SlotAccessDenied on cross-extension access", async () => {
    const { runtime } = runtimeFor("ext-a", {
      slotVersion: "1.0.0",
      data: { foo: 1 },
    });

    await assert.rejects(
      readSlot<{ foo: number }>(
        "ext-b",
        policy<{ foo: number }>({ currentVersion: "1.0.0" }),
        runtime,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ExtensionHost);
        assert.equal(error.code, "SlotAccessDenied");
        return true;
      },
    );
  });
});

describe("readSlot/writeSlot — runtime guard", () => {
  it("throws Session/StoreUnavailable when readSlot is called without a runtime", async () => {
    let caught: unknown;
    try {
      await readSlot<{ foo: number }>(
        "ext-a",
        policy<{ foo: number }>({ currentVersion: "1.0.0" }),
      );
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Session);
    assert.equal(caught.code, "StoreUnavailable");
  });

  it("throws Session/StoreUnavailable when writeSlot is called without a runtime", async () => {
    let caught: unknown;
    try {
      await writeSlot("ext-a", { slotVersion: "1.0.0", data: { foo: 1 } });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Session);
    assert.equal(caught.code, "StoreUnavailable");
  });
});

describe("readSlot — migration error paths", () => {
  it("throws Session/SlotMigrationFailed when policy decides migrate but no migrate fn is defined", async () => {
    const { runtime } = runtimeFor("ext-a", { slotVersion: "1.0.0", data: { foo: 1 } });

    let caught: unknown;
    try {
      await readSlot<{ foo: number }>(
        "ext-a",
        policy<{ foo: number }>({ currentVersion: "2.0.0", decideDrift: () => "migrate" }),
        runtime,
      );
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Session);
    assert.equal(caught.code, "SlotMigrationFailed");
    assert.equal(caught.context["extId"], "ext-a");
    assert.equal(caught.context["storedVersion"], "1.0.0");
    assert.equal(caught.context["targetVersion"], "2.0.0");
  });

  it("throws Session/SlotMigrationFailed when migrate returns a wrong-version slot", async () => {
    const { runtime } = runtimeFor("ext-a", { slotVersion: "1.0.0", data: { foo: 1 } });

    let caught: unknown;
    try {
      await readSlot<{ foo: number }>(
        "ext-a",
        policy<{ foo: number }>({
          currentVersion: "2.0.0",
          decideDrift: () => "migrate",
          migrate: (slot) => ({
            slotVersion: "1.5.0", // wrong target version
            data: slot.data as { foo: number },
          }),
        }),
        runtime,
      );
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Session);
    assert.equal(caught.code, "SlotMigrationFailed");
    assert.equal(caught.context["targetVersion"], "2.0.0");
  });
});

describe("readSlot — migration: Session-error wrapping & async paths", () => {
  it("re-throws Session errors from migrate without rewrapping them", async () => {
    const { runtime } = runtimeFor("ext-a", { slotVersion: "1.0.0", data: { foo: 1 } });
    const original = new Session("custom migration failure", undefined, {
      code: "CustomMigrationCode",
      extId: "ext-a",
    });

    let caught: unknown;
    try {
      await readSlot<{ foo: number }>(
        "ext-a",
        policy<{ foo: number }>({
          currentVersion: "2.0.0",
          decideDrift: () => "migrate",
          migrate: () => {
            throw original;
          },
        }),
        runtime,
      );
    } catch (error) {
      caught = error;
    }

    // The Session error from migrate is re-thrown unchanged.
    assert.equal(caught, original);
  });

  it("wraps a non-Session migration error in Session/SlotMigrationFailed", async () => {
    const { runtime } = runtimeFor("ext-a", { slotVersion: "1.0.0", data: { foo: 1 } });

    let caught: unknown;
    try {
      await readSlot<{ foo: number }>(
        "ext-a",
        policy<{ foo: number }>({
          currentVersion: "2.0.0",
          decideDrift: () => "migrate",
          migrate: () => {
            throw new TypeError("boom");
          },
        }),
        runtime,
      );
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Session);
    assert.equal(caught.code, "SlotMigrationFailed");
    assert.equal(caught.context["extId"], "ext-a");
    assert.ok(caught.cause instanceof TypeError);
  });

  it("supports an async migrate that returns a promise resolving to the next slot", async () => {
    const { runtime } = runtimeFor("ext-a", { slotVersion: "1.0.0", data: { foo: 1 } });

    const stored = await readSlot<{ foo: number; bar: number }>(
      "ext-a",
      policy<{ foo: number; bar: number }>({
        currentVersion: "2.0.0",
        decideDrift: () => "migrate",
        migrate: async (slot) =>
          Promise.resolve({
            slotVersion: "2.0.0",
            data: { ...(slot.data as { foo: number }), bar: 99 },
          }),
      }),
      runtime,
    );

    assert.deepEqual(stored, { slotVersion: "2.0.0", data: { foo: 1, bar: 99 } });
  });

  it("works without an audit recorder (audit is optional on the runtime)", async () => {
    const { runtime } = runtimeFor("ext-a", { slotVersion: "0.9.0", data: { foo: 1 } });
    const runtimeNoAudit = { session: runtime.session };

    const stored = await readSlot<{ foo: number }>(
      "ext-a",
      policy<{ foo: number }>({ currentVersion: "1.0.0", decideDrift: () => "warn" }),
      runtimeNoAudit,
    );

    assert.deepEqual(stored, { slotVersion: "0.9.0", data: { foo: 1 } });
  });
});
