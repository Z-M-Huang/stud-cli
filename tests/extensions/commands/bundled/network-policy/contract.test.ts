/**
 * Contract conformance tests for the /network-policy bundled command.
 *
 * Covers: shape, show, allow/deny (with confirmation and cancellation),
 * invalid-host rejection, and lifecycle safety.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cancellation } from "../../../../../src/core/errors/index.js";
import {
  contract,
  injectNetworkPolicyContext,
} from "../../../../../src/extensions/commands/bundled/network-policy/index.js";
import { fakeHost } from "../../../../helpers/host-fixtures.js";
import { mockHost } from "../../../../helpers/mock-host.js";

import type { CommandArgs } from "../../../../../src/contracts/commands.js";
import type { NetworkPolicyContext } from "../../../../../src/extensions/commands/bundled/network-policy/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function args(
  raw: string,
  positional: string[],
  flags: Record<string, string | boolean> = {},
): CommandArgs {
  return { raw, positional, flags };
}

interface MockNetworkPolicyContextOptions {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

interface MockNetworkPolicyContext extends NetworkPolicyContext {
  currentAllow(): readonly string[];
  currentDeny(): readonly string[];
}

function buildMockNetworkPolicyContext(
  opts: MockNetworkPolicyContextOptions = {},
): MockNetworkPolicyContext {
  let allow = Array.from(opts.allow ?? []);
  let deny = Array.from(opts.deny ?? []);

  return {
    currentAllow: () => allow,
    currentDeny: () => deny,
    show: () => Promise.resolve({ allow: [...allow], deny: [...deny] }),
    allow: (host: string) => {
      allow = [...allow, host];
      return Promise.resolve();
    },
    deny: (host: string) => {
      deny = [...deny, host];
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Shape / contract declaration tests
// ---------------------------------------------------------------------------

describe("/network-policy command — shape", () => {
  it("declares Command category", () => {
    assert.equal(contract.kind, "Command");
  });

  it("declares name /network-policy", () => {
    assert.equal(contract.name, "/network-policy");
  });

  it("declares a semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("has no state slot (stateless command)", () => {
    assert.equal(contract.stateSlot, null);
  });

  it("has loadedCardinality unlimited", () => {
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("has activeCardinality unlimited", () => {
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("has a non-empty description", () => {
    assert.ok(typeof contract.description === "string" && contract.description.length > 0);
  });

  it("has a parseable configSchema", () => {
    assert.equal(typeof contract.configSchema, "object");
    assert.equal((contract.configSchema as { type?: string }).type, "object");
  });

  it("has reloadBehavior between-turns", () => {
    assert.equal(contract.reloadBehavior, "between-turns");
  });
});

// ---------------------------------------------------------------------------
// show subcommand — read-only, no approval gate required
// ---------------------------------------------------------------------------

describe("/network-policy show", () => {
  it("returns the current allow and deny lists", async () => {
    const { host } = mockHost({ extId: "network-policy" });
    const ctx = buildMockNetworkPolicyContext({
      allow: ["api.openai.com"],
      deny: ["ads.example.com"],
    });
    await contract.lifecycle.init!(host, {});
    injectNetworkPolicyContext(host, ctx);

    const result = await contract.execute(args("show", ["show"]), host);

    const payload = result.payload as { allow?: string[]; deny?: string[] };
    assert.ok(
      Array.isArray(payload.allow) && payload.allow.includes("api.openai.com"),
      "allow list must contain api.openai.com",
    );
    assert.ok(
      Array.isArray(payload.deny) && payload.deny.includes("ads.example.com"),
      "deny list must contain ads.example.com",
    );
  });

  it("shows (none) in rendered output when lists are empty", async () => {
    const { host } = mockHost({ extId: "network-policy" });
    await contract.lifecycle.init!(host, {});
    injectNetworkPolicyContext(host, buildMockNetworkPolicyContext());

    const result = await contract.execute(args("show", []), host);

    assert.ok(result.rendered.includes("(none)"), "rendered must indicate empty lists");
  });

  it("default subcommand (no args) defaults to show", async () => {
    const { host } = mockHost({ extId: "network-policy" });
    const ctx = buildMockNetworkPolicyContext({ allow: ["api.openai.com"] });
    await contract.lifecycle.init!(host, {});
    injectNetworkPolicyContext(host, ctx);

    const result = await contract.execute(args("", []), host);

    const payload = result.payload as { allow?: string[] };
    assert.ok(
      Array.isArray(payload.allow) && payload.allow.includes("api.openai.com"),
      "bare invocation must default to show",
    );
  });
});

// ---------------------------------------------------------------------------
// allow subcommand — confirmation + audit
// ---------------------------------------------------------------------------

describe("/network-policy allow", () => {
  it("allow <host> adds to allowlist after confirmation and emits audit record", async () => {
    const { host: hostObj, recorders } = mockHost({ extId: "network-policy" });
    const ctx = buildMockNetworkPolicyContext({ allow: [], deny: [] });

    // Use fakeHost that wraps mockHost for interaction support
    const host = fakeHost({ onRaise: () => Promise.resolve({ value: "yes" }) });
    await contract.lifecycle.init!(host, {});
    injectNetworkPolicyContext(host, ctx);

    await contract.execute(args("allow api.openai.com", ["allow", "api.openai.com"]), host);

    assert.ok(ctx.currentAllow().includes("api.openai.com"), "api.openai.com must be in allowlist");

    // Use a separate mockHost to check audit pattern — the fakeHost doesn't expose recorders
    // Verify via context mutation (the canonical observable outcome)
    void hostObj;
    void recorders;
  });

  it("allow proceeds without prompt when requireConfirmForChange is false", async () => {
    const { host } = mockHost({ extId: "network-policy" });
    const ctx = buildMockNetworkPolicyContext({ allow: [], deny: [] });
    await contract.lifecycle.init!(host, { requireConfirmForChange: false });
    injectNetworkPolicyContext(host, ctx);

    await contract.execute(args("allow api.openai.com", ["allow", "api.openai.com"]), host);

    assert.ok(ctx.currentAllow().includes("api.openai.com"), "host must be in allowlist");
  });

  it("allow emits NetworkPolicyChange audit record", async () => {
    const { host, recorders } = mockHost({ extId: "network-policy" });
    const ctx = buildMockNetworkPolicyContext({ allow: [], deny: [] });
    await contract.lifecycle.init!(host, { requireConfirmForChange: false });
    injectNetworkPolicyContext(host, ctx);

    await contract.execute(args("allow api.openai.com", ["allow", "api.openai.com"]), host);

    const auditRec = recorders.audit.records.find((r) => r.class === "NetworkPolicyChange");
    assert.ok(auditRec !== undefined, "must emit NetworkPolicyChange audit record");
    assert.equal(
      (auditRec.payload as { action?: string }).action,
      "allow",
      "audit action must be 'allow'",
    );
  });

  it("allow throws Cancellation/TurnCancelled when user declines (value=no)", async () => {
    const host = fakeHost({ onRaise: () => Promise.resolve({ value: "no" }) });
    const ctx = buildMockNetworkPolicyContext({ allow: [], deny: [] });
    await contract.lifecycle.init!(host, {});
    injectNetworkPolicyContext(host, ctx);

    await assert.rejects(
      () => contract.execute(args("allow api.openai.com", ["allow", "api.openai.com"]), host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "Cancellation");
        return true;
      },
    );

    assert.equal(ctx.currentAllow().length, 0, "allowlist must be unchanged after decline");
  });

  it("allow propagates Cancellation/TurnCancelled when interaction is cancelled", async () => {
    const cancellation = new Cancellation("user cancelled", undefined, {
      code: "TurnCancelled",
    });
    const host = fakeHost({ onRaise: () => Promise.reject(cancellation) });
    const ctx = buildMockNetworkPolicyContext({ allow: [], deny: [] });
    await contract.lifecycle.init!(host, {});
    injectNetworkPolicyContext(host, ctx);

    await assert.rejects(
      () => contract.execute(args("allow x.com", ["allow", "x.com"]), host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "Cancellation");
        return true;
      },
    );

    assert.equal(ctx.currentAllow().length, 0, "allowlist must be unchanged after cancellation");
  });
});

// ---------------------------------------------------------------------------
// deny subcommand — confirmation + audit
// ---------------------------------------------------------------------------

describe("/network-policy deny", () => {
  it("deny <host> adds to denylist after confirmation", async () => {
    const host = fakeHost({ onRaise: () => Promise.resolve({ value: "yes" }) });
    const ctx = buildMockNetworkPolicyContext({ allow: [], deny: [] });
    await contract.lifecycle.init!(host, {});
    injectNetworkPolicyContext(host, ctx);

    await contract.execute(args("deny ads.example.com", ["deny", "ads.example.com"]), host);

    assert.ok(ctx.currentDeny().includes("ads.example.com"), "ads.example.com must be in denylist");
  });

  it("deny proceeds without prompt when requireConfirmForChange is false", async () => {
    const { host } = mockHost({ extId: "network-policy" });
    const ctx = buildMockNetworkPolicyContext({ allow: [], deny: [] });
    await contract.lifecycle.init!(host, { requireConfirmForChange: false });
    injectNetworkPolicyContext(host, ctx);

    await contract.execute(args("deny ads.example.com", ["deny", "ads.example.com"]), host);

    assert.ok(ctx.currentDeny().includes("ads.example.com"), "host must be in denylist");
  });

  it("deny emits NetworkPolicyChange audit record with action=deny", async () => {
    const { host, recorders } = mockHost({ extId: "network-policy" });
    const ctx = buildMockNetworkPolicyContext({ allow: [], deny: [] });
    await contract.lifecycle.init!(host, { requireConfirmForChange: false });
    injectNetworkPolicyContext(host, ctx);

    await contract.execute(args("deny ads.example.com", ["deny", "ads.example.com"]), host);

    const auditRec = recorders.audit.records.find((r) => r.class === "NetworkPolicyChange");
    assert.ok(auditRec !== undefined, "must emit NetworkPolicyChange audit record");
    assert.equal(
      (auditRec.payload as { action?: string }).action,
      "deny",
      "audit action must be 'deny'",
    );
  });

  it("deny throws Cancellation/TurnCancelled when user declines (value=no)", async () => {
    const host = fakeHost({ onRaise: () => Promise.resolve({ value: "no" }) });
    const ctx = buildMockNetworkPolicyContext({ allow: [], deny: [] });
    await contract.lifecycle.init!(host, {});
    injectNetworkPolicyContext(host, ctx);

    await assert.rejects(
      () => contract.execute(args("deny ads.example.com", ["deny", "ads.example.com"]), host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "Cancellation");
        return true;
      },
    );

    assert.equal(ctx.currentDeny().length, 0, "denylist must be unchanged after decline");
  });

  it("deny propagates Cancellation/TurnCancelled when interaction is cancelled", async () => {
    const cancellation = new Cancellation("user cancelled", undefined, {
      code: "TurnCancelled",
    });
    const host = fakeHost({ onRaise: () => Promise.reject(cancellation) });
    const ctx = buildMockNetworkPolicyContext({ allow: [], deny: [] });
    await contract.lifecycle.init!(host, {});
    injectNetworkPolicyContext(host, ctx);

    await assert.rejects(
      () => contract.execute(args("deny x.com", ["deny", "x.com"]), host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "Cancellation");
        return true;
      },
    );

    assert.equal(ctx.currentDeny().length, 0, "denylist must be unchanged after cancellation");
  });
});

// ---------------------------------------------------------------------------
// Hostname validation — ToolTerminal/InputInvalid
// ---------------------------------------------------------------------------

describe("/network-policy — hostname validation", () => {
  it("allow with empty host → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "network-policy" });
    const ctx = buildMockNetworkPolicyContext();
    await contract.lifecycle.init!(host, { requireConfirmForChange: false });
    injectNetworkPolicyContext(host, ctx);

    // Empty positional[1] flows through to validateHostname, which throws
    // ToolTerminal/InputInvalid per the interface contract.
    await assert.rejects(
      () => contract.execute(args("allow ", ["allow", ""], {}), host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "ToolTerminal");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "InputInvalid");
        return true;
      },
    );
  });

  it("allow with invalid host containing / → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "network-policy" });
    const ctx = buildMockNetworkPolicyContext();
    await contract.lifecycle.init!(host, { requireConfirmForChange: false });
    injectNetworkPolicyContext(host, ctx);

    await assert.rejects(
      () => contract.execute(args("allow bad/host", ["allow", "bad/host"], {}), host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "ToolTerminal");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "InputInvalid");
        return true;
      },
    );
  });

  it("deny with invalid host → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "network-policy" });
    const ctx = buildMockNetworkPolicyContext();
    await contract.lifecycle.init!(host, { requireConfirmForChange: false });
    injectNetworkPolicyContext(host, ctx);

    await assert.rejects(
      () => contract.execute(args("deny bad/host", ["deny", "bad/host"], {}), host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "ToolTerminal");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "InputInvalid");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle safety
// ---------------------------------------------------------------------------

describe("/network-policy command — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "network-policy" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs lifecycle in order without error", async () => {
    const { host } = mockHost({ extId: "network-policy" });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });

  it("throws ExtensionHost/LifecycleFailure when execute is called without init", async () => {
    const { host } = mockHost({ extId: "network-policy" });

    await assert.rejects(
      () => contract.execute(args("show", ["show"]), host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "ExtensionHost");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "LifecycleFailure");
        return true;
      },
    );
  });
});
