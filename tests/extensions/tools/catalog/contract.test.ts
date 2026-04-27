/**
 * Contract conformance tests for the catalog reference tool.
 *
 * Covers: shape, fixed approval key, public metadata only (no internal
 * config/stateSlot fields), filterKind narrowing, filterExtId narrowing,
 * includeDisabled default, and idempotent dispose.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 * Registry data is injected via `setRegistryEntries` from lifecycle.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contract, setRegistryEntries } from "../../../../src/extensions/tools/catalog/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { RegistryEntry } from "../../../../src/extensions/tools/catalog/index.js";

const signal = new AbortController().signal;

// ---------------------------------------------------------------------------
// Fixture entries
// ---------------------------------------------------------------------------

const loadedToolEntry: RegistryEntry = {
  extId: "e1",
  kind: "tools",
  contractVersion: "1.0.0",
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  scope: "bundled",
  status: "loaded",
};

const loadedHookEntry: RegistryEntry = {
  extId: "e2",
  kind: "hooks",
  contractVersion: "1.0.0",
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  scope: "global",
  status: "loaded",
};

const disabledEntry: RegistryEntry = {
  extId: "e3",
  kind: "tools",
  contractVersion: "1.0.0",
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  scope: "project",
  status: "disabled",
};

// Fixture with private internal fields that must not appear in catalog output.
const entryWithInternals: RegistryEntry = {
  extId: "ext-with-internals",
  kind: "providers",
  contractVersion: "2.0.0",
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  scope: "bundled",
  status: "loaded",
  // These private fields must be stripped by redact.ts and must never reach the model.
  config: { providerRef: "internal-config-value", nested: { setting: "internal-setting" } },
  stateSlot: { cachedData: "internal-state-value", sessionInfo: "internal-session-info" },
};

// ---------------------------------------------------------------------------
// Shape / contract declaration
// ---------------------------------------------------------------------------

describe("catalog tool — shape", () => {
  it("declares Tool category", () => {
    assert.equal(contract.kind, "Tool");
  });

  it("registers under manifestKey 'catalog'", () => {
    assert.equal(contract.discoveryRules.manifestKey, "catalog");
  });

  it("is gated by the approval stack", () => {
    assert.equal(contract.gated, true);
  });

  it("declares a semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("has no state slot (stateless tool)", () => {
    assert.equal(contract.stateSlot, null);
  });

  it("loadedCardinality is unlimited", () => {
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("activeCardinality is unlimited", () => {
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("exposes inputSchema and outputSchema as objects", () => {
    assert.equal(typeof contract.inputSchema, "object");
    assert.equal(typeof contract.outputSchema, "object");
  });
});

// ---------------------------------------------------------------------------
// Approval key — , Q-8 resolution
// ---------------------------------------------------------------------------

describe("catalog tool — deriveApprovalKey", () => {
  it("returns fixed 'catalog' for empty args", () => {
    assert.equal(contract.deriveApprovalKey({}), "catalog");
  });

  it("returns fixed 'catalog' regardless of filter args", () => {
    assert.equal(contract.deriveApprovalKey({ filterKind: "tools" }), "catalog");
    assert.equal(contract.deriveApprovalKey({ filterExtId: "e1" }), "catalog");
    assert.equal(contract.deriveApprovalKey({ filterKind: "hooks", filterExtId: "e2" }), "catalog");
  });
});

// ---------------------------------------------------------------------------
// Execute — public metadata only (no internal config or stateSlot)
// ---------------------------------------------------------------------------

describe("catalog tool — internal field redaction", () => {
  it("returns only the public CatalogEntry fields — no config or stateSlot data", async () => {
    setRegistryEntries([entryWithInternals]);
    const { host } = mockHost({ extId: "catalog" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({}, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.entries.length, 1);
      const serialized = JSON.stringify(result.value);
      // Internal field values must not appear in the output.
      assert.equal(serialized.includes("internal-config-value"), false);
      assert.equal(serialized.includes("internal-setting"), false);
      assert.equal(serialized.includes("internal-state-value"), false);
      assert.equal(serialized.includes("internal-session-info"), false);
      // Internal field names must not appear either.
      assert.equal(serialized.includes("providerRef"), false);
      assert.equal(serialized.includes("stateSlot"), false);
    }
    await contract.lifecycle.dispose!(host);
  });

  it("entry public fields are present and correct in the result", async () => {
    setRegistryEntries([loadedToolEntry]);
    const { host } = mockHost({ extId: "catalog" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({}, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      const entry = result.value.entries[0];
      assert.equal(entry?.extId, "e1");
      assert.equal(entry?.kind, "tools");
      assert.equal(entry?.contractVersion, "1.0.0");
      assert.equal(entry?.scope, "bundled");
      assert.equal(entry?.status, "loaded");
    }
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — filterKind
// ---------------------------------------------------------------------------

describe("catalog tool — filterKind", () => {
  it("returns only entries whose kind matches the filter", async () => {
    setRegistryEntries([loadedToolEntry, loadedHookEntry]);
    const { host } = mockHost({ extId: "catalog" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({ filterKind: "hooks" }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.entries.length, 1);
      assert.equal(result.value.entries[0]?.extId, "e2");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("returns empty list for an unknown kind value — no error", async () => {
    setRegistryEntries([loadedToolEntry]);
    const { host } = mockHost({ extId: "catalog" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({ filterKind: "nonexistent-category" }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.entries.length, 0);
    }
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — filterExtId
// ---------------------------------------------------------------------------

describe("catalog tool — filterExtId", () => {
  it("returns only the entry with the matching extId", async () => {
    setRegistryEntries([loadedToolEntry, loadedHookEntry]);
    const { host } = mockHost({ extId: "catalog" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({ filterExtId: "e1" }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.entries.length, 1);
      assert.equal(result.value.entries[0]?.extId, "e1");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("returns empty list for an unknown extId — no error", async () => {
    setRegistryEntries([loadedToolEntry]);
    const { host } = mockHost({ extId: "catalog" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({ filterExtId: "does-not-exist" }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.entries.length, 0);
    }
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — disabled extension handling
// ---------------------------------------------------------------------------

describe("catalog tool — includeDisabled", () => {
  it("omits disabled entries by default (includeDisabled absent)", async () => {
    setRegistryEntries([loadedToolEntry, disabledEntry]);
    const { host } = mockHost({ extId: "catalog" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({}, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.entries.length, 1);
      assert.equal(result.value.entries[0]?.extId, "e1");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("omits disabled entries when includeDisabled is explicitly false", async () => {
    setRegistryEntries([loadedToolEntry, disabledEntry]);
    const { host } = mockHost({ extId: "catalog" });
    await contract.lifecycle.init!(host, { includeDisabled: false });

    const result = await contract.execute({}, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.entries.length, 1);
    }
    await contract.lifecycle.dispose!(host);
  });

  it("includes disabled entries when includeDisabled is true", async () => {
    setRegistryEntries([loadedToolEntry, disabledEntry]);
    const { host } = mockHost({ extId: "catalog" });
    await contract.lifecycle.init!(host, { includeDisabled: true });

    const result = await contract.execute({}, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.entries.length, 2);
      const statuses = result.value.entries.map((e) => e.status);
      assert.ok(statuses.includes("disabled"));
    }
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — empty registry
// ---------------------------------------------------------------------------

describe("catalog tool — empty registry", () => {
  it("returns an empty entries array when no extensions are registered", async () => {
    setRegistryEntries([]);
    const { host } = mockHost({ extId: "catalog" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({}, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.entries.length, 0);
    }
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("catalog tool — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "catalog" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs init then dispose without error", async () => {
    const { host } = mockHost({ extId: "catalog" });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });

  it("dispose after dispose does not throw", async () => {
    const { host } = mockHost({ extId: "catalog" });
    await contract.lifecycle.init!(host, {});
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });
});
