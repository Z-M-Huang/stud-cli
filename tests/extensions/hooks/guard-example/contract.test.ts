/**
 * Contract conformance tests for the guard-example reference hook.
 *
 * Exercises: block path, no-op paths, config-validation error, idempotent dispose.
 * Uses node:test + node:assert/strict (project canonical test runner).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contract } from "../../../../src/extensions/hooks/guard-example/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { GuardHandler } from "../../../../src/contracts/hooks.js";
import type { ToolCallPayload } from "../../../../src/extensions/hooks/guard-example/index.js";

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

type GuardFn = GuardHandler<ToolCallPayload>;

function callGuard(host: ReturnType<typeof mockHost>["host"], payload: ToolCallPayload) {
  return (contract.handler as GuardFn)(payload, host);
}

// ---------------------------------------------------------------------------
// Shape / contract declaration tests
// ---------------------------------------------------------------------------

describe("guard-example hook — shape", () => {
  it("declares Hook category", () => {
    assert.equal(contract.kind, "Hook");
  });

  it("declares guard sub-kind", () => {
    assert.equal(contract.registration.subKind, "guard");
  });

  it("attaches to TOOL_CALL/pre slot with per-call firing mode", () => {
    assert.equal(contract.registration.slot, "TOOL_CALL/pre");
    assert.equal(contract.registration.firingMode, "per-call");
  });

  it("declares a semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("has no state slot (stateless hook)", () => {
    assert.equal(contract.stateSlot, null);
  });
});

// ---------------------------------------------------------------------------
// Guard behavior tests (block path + no-op paths) —
// ---------------------------------------------------------------------------

describe("guard-example hook — behavior", () => {
  it("blocks rm -rf prefix with Validation/Forbidden", async () => {
    const { host } = mockHost({ extId: "guard-example" });
    await contract.lifecycle.init!(host, {});

    const result = await callGuard(host, {
      tool: { id: "bash" },
      args: { command: "rm -rf /tmp" },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "Validation");
      assert.equal(result.error.context["code"], "Forbidden");
    }
  });

  it("blocks a custom prefix supplied in config", async () => {
    const { host } = mockHost({ extId: "guard-example" });
    await contract.lifecycle.init!(host, { blockedPrefixes: ["sudo", "rm -rf"] });

    const result = await callGuard(host, {
      tool: { id: "bash" },
      args: { command: "sudo make install" },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.context["code"], "Forbidden");
    }
  });

  it("is a no-op for non-matching bash commands", async () => {
    const { host } = mockHost({ extId: "guard-example" });
    await contract.lifecycle.init!(host, {});

    const result = await callGuard(host, {
      tool: { id: "bash" },
      args: { command: "ls -la" },
    });

    assert.equal(result.ok, true);
  });

  it("is a no-op for non-bash tools", async () => {
    const { host } = mockHost({ extId: "guard-example" });
    await contract.lifecycle.init!(host, {});

    const result = await callGuard(host, {
      tool: { id: "read" },
      args: { path: "/x" },
    });

    assert.equal(result.ok, true);
  });

  it("is a no-op for bash commands with missing args.command", async () => {
    const { host } = mockHost({ extId: "guard-example" });
    await contract.lifecycle.init!(host, {});

    const result = await callGuard(host, {
      tool: { id: "bash" },
      args: {},
    });

    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Config-validation + lifecycle tests
// ---------------------------------------------------------------------------

describe("guard-example hook — lifecycle", () => {
  it("throws Validation/ConfigSchemaViolation when blockedPrefixes contains a non-string", async () => {
    const { host } = mockHost({ extId: "guard-example" });

    await assert.rejects(
      () =>
        contract.lifecycle.init!(host, {
          blockedPrefixes: [42 as unknown as string],
        }),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "Validation");
        assert.equal(
          (err as { context?: { code?: unknown } }).context?.code,
          "ConfigSchemaViolation",
        );
        return true;
      },
    );
  });

  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "guard-example" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs lifecycle in order without error", async () => {
    const { host } = mockHost({ extId: "guard-example" });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });
});
