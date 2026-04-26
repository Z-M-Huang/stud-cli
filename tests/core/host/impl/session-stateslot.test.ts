/**
 * Tests for createHostSession — stateSlot guard and session accessors.
 *
 * Covers:
 *   AC-115 — slot-guard denial: accessing another extension's slot throws
 *             `ExtensionHost/SlotAccessDenied` and records an audit event.
 *   AC-115 — slot-guard permit: accessing own slot succeeds.
 *   AC-56  — returned object is Object.freeze'd.
 *
 * Wiki: core/Host-API.md + contracts/Extension-State.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExtensionHost } from "../../../../src/core/errors/extension-host.js";
import { createHostSession } from "../../../../src/core/host/impl/session.js";

import type { HostAuditImpl } from "../../../../src/core/host/impl/audit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(extId: string, storeData: unknown = {}, auditSink?: (e: unknown) => void) {
  const auditEvents: unknown[] = [];
  return {
    host: createHostSession({
      extId,
      stateStore: {
        get: (_id: string) => storeData,
        set: async (_id: string, _v: unknown) => {
          /* no-op stub */
        },
      },
      sessionId: "s1",
      mode: "ask",
      audit: {
        record: (e: { class: string; code: string; data: Readonly<Record<string, unknown>> }) => {
          auditEvents.push(e);
          auditSink?.(e);
        },
      } as HostAuditImpl,
    }),
    auditEvents,
  };
}

// ---------------------------------------------------------------------------
// AC-115: slot-guard denial
// ---------------------------------------------------------------------------

describe("createHostSession — stateSlot denial (AC-115)", () => {
  it("throws ExtensionHost when extId does not match own id", () => {
    const { host } = makeSession("ext.me");

    assert.throws(
      () => host.stateSlot("ext.other").get(),
      (err) => {
        assert.ok(err instanceof ExtensionHost);
        assert.equal(err.class, "ExtensionHost");
        assert.equal(err.context["code"], "SlotAccessDenied");
        return true;
      },
    );
  });

  it("records an audit event on denial", () => {
    const { host, auditEvents } = makeSession("ext.me");

    try {
      host.stateSlot("ext.other").get();
    } catch {
      // expected — we are testing the audit side-effect
    }

    assert.equal(auditEvents.length, 1);
    const ev = auditEvents[0] as { code: string; class: string };
    assert.equal(ev.code, "SlotAccessDenied");
    assert.equal(ev.class, "ExtensionHost");
  });
});

// ---------------------------------------------------------------------------
// AC-115: slot-guard permit
// ---------------------------------------------------------------------------

describe("createHostSession — stateSlot permit (AC-115)", () => {
  it("allows access when extId matches own id", () => {
    const { host } = makeSession("ext.me", { x: 1 });

    const value = host.stateSlot("ext.me").get<{ x: number }>();
    assert.deepEqual(value, { x: 1 });
  });

  it("does not emit an audit event on permitted access", () => {
    const { host, auditEvents } = makeSession("ext.me", { y: 2 });

    host.stateSlot("ext.me").get();

    assert.equal(auditEvents.length, 0);
  });

  it("set() writes to the store with the correct extId and value", async () => {
    const setCalls: { extId: string; value: unknown }[] = [];
    const host = createHostSession({
      extId: "ext.me",
      stateStore: {
        get: () => undefined,
        set: (id: string, v: unknown): Promise<void> => {
          setCalls.push({ extId: id, value: v });
          return Promise.resolve();
        },
      },
      sessionId: "s1",
      mode: "ask",
      audit: {
        record: (_e: unknown) => {
          void 0;
        },
      } as HostAuditImpl,
    });

    await host.stateSlot("ext.me").set({ y: 2 });

    assert.equal(setCalls.length, 1);
    assert.equal(setCalls[0]?.extId, "ext.me");
    assert.deepEqual(setCalls[0]?.value, { y: 2 });
  });
});

// ---------------------------------------------------------------------------
// AC-56: frozen shape
// ---------------------------------------------------------------------------

describe("createHostSession — frozen shape (AC-56)", () => {
  it("returns a frozen object", () => {
    const { host } = makeSession("ext.me");
    assert.equal(Object.isFrozen(host), true);
  });

  it("throws when attempting to assign a new property", () => {
    const { host } = makeSession("ext.me");
    assert.throws(() => {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      (host as unknown as Record<string, unknown>)["newMethod"] = () => {};
    });
  });
});

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

describe("createHostSession — accessors", () => {
  it("sessionId() returns the provided sessionId", () => {
    const { host } = makeSession("ext.me");
    assert.equal(host.sessionId(), "s1");
  });

  it("mode() returns the provided mode", () => {
    const { host } = makeSession("ext.me");
    assert.equal(host.mode(), "ask");
  });
});
