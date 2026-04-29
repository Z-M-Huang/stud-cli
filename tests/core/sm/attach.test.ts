import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRuntimeCollector } from "../../../src/core/host/internal/runtime-collector.js";
import { attachSM } from "../../../src/core/sm/attach.js";

import type { HostAPI } from "../../../src/core/host/host-api.js";
import type { StateSlot } from "../../../src/core/lifecycle/extension-state.js";

interface SMAttachedAudit {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

interface AttachTestHost extends HostAPI {
  readonly smRuntime: {
    attach(host: HostAPI): Promise<void>;
    setAttachedStateMachine(input: {
      readonly smId: string;
      readonly deliveredSlot: StateSlot<unknown> | null;
    }): void;
    readonly attached: {
      readonly smId: string;
      readonly deliveredSlot: StateSlot<unknown> | null;
    } | null;
  };
}

function newHost(order: string[] = []): AttachTestHost {
  let slotState: Readonly<Record<string, unknown>> | null = null;
  const auditRecords: SMAttachedAudit[] = [];
  let attached: {
    readonly smId: string;
    readonly deliveredSlot: StateSlot<unknown> | null;
  } | null = null;

  const host = {
    session: {
      id: "session-1",
      mode: "ask",
      projectRoot: "/tmp/.stud",
      stateSlot: () => ({
        read: () => Promise.resolve(slotState),
        write: (next: Readonly<Record<string, unknown>>) => {
          slotState = next;
          order.push("slot-delivered");
          return Promise.resolve();
        },
      }),
    },
    events: {
      on: () => undefined,
      off: () => undefined,
      emit: (event: string) => {
        if (event === "SMAttached") {
          order.push("event-emitted");
        }
      },
    },
    config: { readOwn: () => Promise.resolve({}) },
    env: { get: () => Promise.resolve("env") },
    tools: { list: () => [], get: () => undefined },
    prompts: { resolveByURI: (uri: string) => Promise.resolve({ uri, content: "" }) },
    resources: {
      fetch: (uri: string) => Promise.resolve({ uri, mimeType: undefined, content: "" }),
    },
    mcp: {
      listServers: () => [],
      listTools: () => [],
      callTool: () => Promise.resolve({ content: [], isError: false }),
    },
    audit: {
      write: (record: SMAttachedAudit) => {
        auditRecords.push(record);
        return Promise.resolve();
      },
    },
    observability: { emit: () => undefined, suppress: () => undefined },
    interaction: { raise: () => Promise.resolve({ value: "ok" }) },
    commands: { list: () => [], complete: () => [], dispatch: () => Promise.resolve({ ok: true }) },
    metrics: createRuntimeCollector().reader,
    smRuntime: {
      async attach(runtimeHost: HostAPI): Promise<void> {
        const sawSlot = (await runtimeHost.session.stateSlot("ralph").read()) !== null;
        order.push("attach-fired");
        order.push(sawSlot ? "attach-saw-slot" : "attach-saw-no-slot");
      },
      setAttachedStateMachine(input: {
        readonly smId: string;
        readonly deliveredSlot: StateSlot<unknown> | null;
      }): void {
        attached = input;
      },
      get attached() {
        return attached;
      },
    },
  } satisfies AttachTestHost;

  return Object.assign(host, { auditRecords });
}

function hostWithOrderSpy(order: string[]): AttachTestHost {
  return newHost(order);
}

describe("attachSM", () => {
  it("delivers the state slot before attach fires on resume", async () => {
    const order: string[] = [];
    const host = hostWithOrderSpy(order);

    const result = await attachSM({
      smId: "ralph",
      host,
      deliveredSlot: { slotVersion: "1.0.0", data: { step: 5 } },
      resumed: true,
    });

    assert.ok(order.indexOf("slot-delivered") < order.indexOf("attach-fired"));
    assert.ok(order.includes("attach-saw-slot"));
    assert.equal(result.sawSlot, true);
    assert.deepEqual(host.smRuntime.attached, {
      smId: "ralph",
      deliveredSlot: { slotVersion: "1.0.0", data: { step: 5 } },
    });
  });

  it("attaches without a slot on a fresh (non-resumed) session", async () => {
    const order: string[] = [];
    const host = newHost(order);

    const result = await attachSM({
      smId: "ralph",
      host,
      deliveredSlot: null,
      resumed: false,
    });

    assert.equal(result.sawSlot, false);
    assert.ok(order.includes("attach-fired"));
    assert.ok(order.includes("attach-saw-no-slot"));
  });

  it("throws Validation/SMAlreadyAttached when another SM is attached", async () => {
    const host = newHost();

    await attachSM({
      smId: "ralph",
      host,
      deliveredSlot: null,
      resumed: false,
    });

    await assert.rejects(
      () =>
        attachSM({
          smId: "other",
          host,
          deliveredSlot: null,
          resumed: false,
        }),
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Validation");
        assert.equal((err as { context?: { code?: string } }).context?.code, "SMAlreadyAttached");
        return true;
      },
    );
  });

  it("wraps an SM attach() throw as ExtensionHost/LifecycleFailure", async () => {
    const host = newHost();
    host.smRuntime.attach = () => Promise.reject(new Error("boom"));

    await assert.rejects(
      () =>
        attachSM({
          smId: "ralph",
          host,
          deliveredSlot: null,
          resumed: false,
        }),
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "ExtensionHost");
        assert.equal((err as { context?: { code?: string } }).context?.code, "LifecycleFailure");
        return true;
      },
    );
  });
});

describe("attachSM — resume slot validation", () => {
  it("throws Session/ResumeMismatch when resumed=true but deliveredSlot is null", async () => {
    const host = newHost();
    await assert.rejects(
      () =>
        attachSM({
          smId: "ralph",
          host,
          deliveredSlot: null,
          resumed: true,
        }),
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Session");
        assert.equal((err as { context?: { code?: string } }).context?.code, "ResumeMismatch");
        assert.equal((err as { context?: { smId?: string } }).context?.smId, "ralph");
        return true;
      },
    );
  });

  it("delivers the slot via session.stateSlot.write when resumed=true with a slot", async () => {
    const order: string[] = [];
    const host = newHost(order);
    const result = await attachSM({
      smId: "ralph",
      host,
      deliveredSlot: { slotVersion: "1.0.0", data: { iteration: 3 } },
      resumed: true,
    });
    assert.equal(result.smId, "ralph");
    assert.equal(result.sawSlot, true);
    // The write happens before attach fires.
    const writeIdx = order.indexOf("slot-delivered");
    const attachIdx = order.indexOf("attach-fired");
    assert.ok(writeIdx >= 0);
    assert.ok(attachIdx >= 0);
    assert.ok(writeIdx < attachIdx, "slot must be delivered before attach()");
  });

  it("re-attaching the same smId is idempotent (does not throw SMAlreadyAttached)", async () => {
    const host = newHost();
    await attachSM({
      smId: "ralph",
      host,
      deliveredSlot: null,
      resumed: false,
    });
    // Second attach with the SAME smId should NOT throw — the guard only
    // fires when a DIFFERENT smId is requested.
    await attachSM({
      smId: "ralph",
      host,
      deliveredSlot: null,
      resumed: false,
    });
  });
});

describe("attachSM — slotsEqual branches", () => {
  it("slotsEqual handles (stored=null, delivered=non-null) via broken-write path", async () => {
    // resumed=true triggers deliverSlot's write path, but the host's write is
    // a no-op that silently drops the value. verifyDeliveredSlot reads back
    // null (initial state never updated), then slotsEqual is called with
    // (null, non-null) — exercises the LEFT-null branch on attach.ts:45-46.
    // The result: ResumeMismatch is thrown because the slot wasn't delivered.
    const host = {
      ...newHost(),
      session: {
        id: "session-1",
        mode: "ask" as const,
        projectRoot: "/tmp/.stud",
        stateSlot: () => ({
          read: () => Promise.resolve(null),
          write: () => Promise.resolve(),
        }),
      },
    };
    await assert.rejects(
      () =>
        attachSM({
          smId: "ralph",
          host,
          deliveredSlot: { slotVersion: "1.0.0", data: { x: 1 } },
          resumed: true,
        }),
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Session");
        assert.equal((err as { context?: { code?: string } }).context?.code, "ResumeMismatch");
        return true;
      },
    );
  });

  it("slotsEqual handles (stored=non-null, delivered=null) — exercises right-null branch", async () => {
    // Pre-populate the host's slot, then attach with resumed=false and
    // deliveredSlot=null. verifyDeliveredSlot reads the non-null stored,
    // slotsEqual is called with (non-null, null) — exercises the right-side
    // of the `||` in slotsEqual at attach.ts:45. resumed=false short-circuits
    // the throw, so the call succeeds with sawSlot=true.
    const host = {
      ...newHost(),
      session: {
        id: "session-1",
        mode: "ask" as const,
        projectRoot: "/tmp/.stud",
        stateSlot: () => ({
          read: () => Promise.resolve({ slotVersion: "0.9.0", data: { existing: true } }),
          write: () => Promise.resolve(),
        }),
      },
    };
    const result = await attachSM({
      smId: "ralph",
      host,
      deliveredSlot: null,
      resumed: false,
    });
    assert.equal(result.sawSlot, true);
  });

  it("slotsEqual handles (stored=null, delivered=null) when resumed=false (both-null branch)", async () => {
    // resumed=false, deliveredSlot=null, host has no stored slot.
    // This exercises slotsEqual(null, null) which returns true via the
    // `left === null && right === null` branch on attach.ts:46.
    const host = newHost();
    const result = await attachSM({
      smId: "ralph",
      host,
      deliveredSlot: null,
      resumed: false,
    });
    assert.equal(result.sawSlot, false); // stored was null
  });

  it("throws Session/ResumeMismatch when stored slot doesn't match the delivered slot", async () => {
    // Pre-populate the host's slot with a value DIFFERENT from what we'll
    // deliver, then attach with resumed=true. deliverSlot writes the new
    // slot; verifyDeliveredSlot reads it back. With a broken host whose
    // write does NOT update the read-store, verify will see the stale
    // value and throw ResumeMismatch — exercises lines 81-85.
    const storedState: Readonly<Record<string, unknown>> | null = {
      slotVersion: "0.9.0",
      data: { stale: true },
    };
    const host = {
      ...newHost(),
      session: {
        id: "session-1",
        mode: "ask" as const,
        projectRoot: "/tmp/.stud",
        stateSlot: () => ({
          read: () => Promise.resolve(storedState),
          // Broken write: silently drops the new value.
          write: (_next: Readonly<Record<string, unknown>>) => Promise.resolve(),
        }),
      },
    };
    void storedState; // referenced via closure in stateSlot
    await assert.rejects(
      () =>
        attachSM({
          smId: "ralph",
          host,
          deliveredSlot: { slotVersion: "1.0.0", data: { fresh: true } },
          resumed: true,
        }),
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Session");
        assert.equal((err as { context?: { code?: string } }).context?.code, "ResumeMismatch");
        return true;
      },
    );
  });
});
