/**
 * Contract conformance tests for the transform-example reference hook.
 *
 * Exercises: shape assertions, emoji stripping, empty-string fallback,
 * input immutability, no-init default, config validation, idempotent dispose.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contract } from "../../../../src/extensions/hooks/transform-example/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { TransformHandler } from "../../../../src/contracts/hooks.js";
import type { RenderPayload } from "../../../../src/extensions/hooks/transform-example/index.js";

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

type TransformFn = TransformHandler<RenderPayload>;

function callTransform(
  host: ReturnType<typeof mockHost>["host"],
  payload: RenderPayload,
): Promise<RenderPayload> {
  return (contract.handler as TransformFn)(payload, host);
}

// ---------------------------------------------------------------------------
// Shape / contract declaration tests
// ---------------------------------------------------------------------------

describe("transform-example hook — shape", () => {
  it("declares Hook category", () => {
    assert.equal(contract.kind, "Hook");
  });

  it("declares transform sub-kind", () => {
    assert.equal(contract.registration.subKind, "transform");
  });

  it("attaches to RENDER/pre slot with per-stage firing mode", () => {
    assert.equal(contract.registration.slot, "RENDER/pre");
    assert.equal(contract.registration.firingMode, "per-stage");
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

  it("has a parseable configSchema", () => {
    assert.equal(typeof contract.configSchema, "object");
    assert.equal((contract.configSchema as { type?: string }).type, "object");
  });
});

// ---------------------------------------------------------------------------
// Transform behavior tests — AC-92
// ---------------------------------------------------------------------------

describe("transform-example hook — behavior", () => {
  it("strips emoji from rendered text", async () => {
    const { host } = mockHost({ extId: "transform-example" });
    await contract.lifecycle.init!(host, {});

    const out = await callTransform(host, { text: "hello 👋 world 🌍!" });
    assert.equal(out.text, "hello  world !");
  });

  it("returns empty string when all text is stripped (never refuses)", async () => {
    const { host } = mockHost({ extId: "transform-example" });
    await contract.lifecycle.init!(host, {});

    const out = await callTransform(host, { text: "👋🌍🔥" });
    assert.equal(out.text, "");
  });

  it("does not mutate the input payload", async () => {
    const { host } = mockHost({ extId: "transform-example" });
    await contract.lifecycle.init!(host, {});

    const input: RenderPayload = { text: "hi 👋" };
    await callTransform(host, input);
    assert.equal(input.text, "hi 👋");
  });

  it("passes through plain text with no emoji unchanged", async () => {
    const { host } = mockHost({ extId: "transform-example" });
    await contract.lifecycle.init!(host, {});

    const out = await callTransform(host, { text: "plain text" });
    assert.equal(out.text, "plain text");
  });

  it("works without init (falls back to default emoji ranges)", async () => {
    const { host } = mockHost({ extId: "transform-example" });

    const out = await callTransform(host, { text: "hello 👋 world" });
    assert.equal(out.text, "hello  world");
  });

  it("respects custom removeUnicodeRanges from config", async () => {
    const { host } = mockHost({ extId: "transform-example" });
    // Strip only U+0041–U+005A (ASCII uppercase A–Z)
    await contract.lifecycle.init!(host, {
      removeUnicodeRanges: [{ from: "41", to: "5A" }],
    });

    const out = await callTransform(host, { text: "Hello World" });
    // H, W removed; e, l, l, o, space, o, r, l, d remain
    assert.equal(out.text, "ello orld");
  });
});

// ---------------------------------------------------------------------------
// Config-validation + lifecycle tests
// ---------------------------------------------------------------------------

describe("transform-example hook — lifecycle", () => {
  it("throws Validation/ConfigSchemaViolation on malformed hex range", async () => {
    const { host } = mockHost({ extId: "transform-example" });

    await assert.rejects(
      () =>
        contract.lifecycle.init!(host, {
          removeUnicodeRanges: [
            { from: "not-hex", to: "xx" } as unknown as { from: string; to: string },
          ],
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
    const { host } = mockHost({ extId: "transform-example" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs lifecycle in order without error", async () => {
    const { host } = mockHost({ extId: "transform-example" });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });
});
