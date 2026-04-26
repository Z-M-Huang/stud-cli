import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvProvider } from "../../../src/core/env/provider.js";

// Shared noop audit sink for tests that do not inspect audit events.
function makeNoopAudit() {
  return {
    record: (_e: { class: string; code: string; data: unknown }) => {
      void _e;
    },
  };
}

describe("createEnvProvider — resolution order", () => {
  it("resolves OS env first before any settings scope", () => {
    const p = createEnvProvider({
      osEnv: { A: "os-a" },
      settings: { bundled: { A: "b-a" }, global: { A: "g-a" }, project: { A: "p-a" } },
      audit: makeNoopAudit(),
    });
    p.declare("ext.x", "A");
    assert.equal(p.get("ext.x", "A"), "os-a");
  });

  it("resolves settings.project before settings.global and bundled", () => {
    const p = createEnvProvider({
      osEnv: {},
      settings: { bundled: { B: "b-b" }, global: { B: "g-b" }, project: { B: "p-b" } },
      audit: makeNoopAudit(),
    });
    p.declare("ext.x", "B");
    assert.equal(p.get("ext.x", "B"), "p-b");
  });

  it("resolves settings.global when project is absent", () => {
    const p = createEnvProvider({
      osEnv: {},
      settings: { bundled: { C: "b-c" }, global: { C: "g-c" }, project: {} },
      audit: makeNoopAudit(),
    });
    p.declare("ext.x", "C");
    assert.equal(p.get("ext.x", "C"), "g-c");
  });

  it("resolves settings.bundled as last resort", () => {
    const p = createEnvProvider({
      osEnv: {},
      settings: { bundled: { D: "b-d" }, global: {}, project: {} },
      audit: makeNoopAudit(),
    });
    p.declare("ext.x", "D");
    assert.equal(p.get("ext.x", "D"), "b-d");
  });
});

describe("createEnvProvider — declare-first enforcement", () => {
  it("throws Validation/EnvNameUndeclared when get precedes declare", () => {
    const p = createEnvProvider({
      osEnv: { A: "x" },
      settings: { bundled: {}, global: {}, project: {} },
      audit: makeNoopAudit(),
    });
    let err: unknown;
    try {
      p.get("ext.x", "A");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "should throw");
    assert.equal(
      (err as unknown as { context: { code: string } }).context.code,
      "EnvNameUndeclared",
    );
  });

  it("throws Validation/EnvNameNotSet when name is absent in all layers", () => {
    const p = createEnvProvider({
      osEnv: {},
      settings: { bundled: {}, global: {}, project: {} },
      audit: makeNoopAudit(),
    });
    p.declare("ext.x", "MISSING");
    let err: unknown;
    try {
      p.get("ext.x", "MISSING");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "should throw");
    assert.equal((err as unknown as { context: { code: string } }).context.code, "EnvNameNotSet");
  });

  it("declaration is per extId+name pair — another extId cannot get without its own declare", () => {
    const p = createEnvProvider({
      osEnv: { A: "val" },
      settings: { bundled: {}, global: {}, project: {} },
      audit: makeNoopAudit(),
    });
    p.declare("ext.x", "A");
    // ext.y did NOT declare A
    let err: unknown;
    try {
      p.get("ext.y", "A");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "should throw for undeclared ext.y");
    assert.equal(
      (err as unknown as { context: { code: string } }).context.code,
      "EnvNameUndeclared",
    );
  });
});

describe("createEnvProvider — audit events", () => {
  it("emits EnvResolved audit with metadata only (never the value)", () => {
    const audit: { class: string; code: string; data: unknown }[] = [];
    const p = createEnvProvider({
      osEnv: { A: "plaintext-secret" },
      settings: { bundled: {}, global: {}, project: {} },
      audit: { record: (e) => audit.push(e) },
    });
    p.declare("ext.x", "A");
    p.get("ext.x", "A");

    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.code, "EnvResolved");

    // The serialised event must not contain the resolved value.
    const serialised = JSON.stringify(audit[0]!.data);
    assert.equal(
      serialised.includes("plaintext-secret"),
      false,
      "audit event must not contain the resolved value",
    );

    // The event must contain the expected metadata fields.
    const data = audit[0]!.data as Record<string, unknown>;
    assert.equal(data["extId"], "ext.x");
    assert.equal(data["name"], "A");
    assert.equal(data["source"], "os");
    assert.equal(data["scopeLayer"], "os");
  });

  it("emits one audit event per successful get call", () => {
    const audit: unknown[] = [];
    const p = createEnvProvider({
      osEnv: { A: "val" },
      settings: { bundled: {}, global: {}, project: {} },
      audit: { record: (e) => audit.push(e) },
    });
    p.declare("ext.x", "A");
    p.get("ext.x", "A");
    p.get("ext.x", "A");
    assert.equal(audit.length, 2);
  });

  it("does not emit an audit event when get throws", () => {
    const audit: unknown[] = [];
    const p = createEnvProvider({
      osEnv: {},
      settings: { bundled: {}, global: {}, project: {} },
      audit: { record: (e) => audit.push(e) },
    });
    p.declare("ext.x", "GONE");
    try {
      p.get("ext.x", "GONE");
    } catch {
      /* expected */
    }
    assert.equal(audit.length, 0);
  });
});

describe("createEnvProvider — no bulk-read API", () => {
  it("does not expose list, all, or keys methods", () => {
    const p = createEnvProvider({
      osEnv: {},
      settings: { bundled: {}, global: {}, project: {} },
      audit: makeNoopAudit(),
    });
    assert.equal((p as unknown as Record<string, unknown>)["list"], undefined);
    assert.equal((p as unknown as Record<string, unknown>)["all"], undefined);
    assert.equal((p as unknown as Record<string, unknown>)["keys"], undefined);
  });
});
