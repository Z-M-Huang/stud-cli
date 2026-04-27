/**
 * Contract conformance tests for the ask-user reference tool.
 *
 * Covers: shape, approval-key stability, interactor dispatch, empty-input
 * rejection, user cancellation, execution timeout, and idempotent dispose.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cancellation, ToolTransient } from "../../../../src/core/errors/index.js";
import { contract } from "../../../../src/extensions/tools/ask-user/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { InteractionAPI } from "../../../../src/core/host/api/interaction.js";
import type { HostAPI } from "../../../../src/core/host/host-api.js";

// ---------------------------------------------------------------------------
// Test helpers — build hosts with custom interaction stubs
// ---------------------------------------------------------------------------

/**
 * Spread the frozen mockHost into a new frozen host, replacing the interaction
 * surface with a custom stub. This avoids the default "NotImplemented" stub.
 */
function hostWithInteraction(interaction: InteractionAPI): HostAPI {
  const { host } = mockHost({ extId: "ask-user" });
  return Object.freeze({ ...host, interaction });
}

/** Returns a host whose interactor answers with the given string. */
function makeAnsweringHost(answer: string): HostAPI {
  return hostWithInteraction({
    raise: () => Promise.resolve({ value: answer }),
  });
}

/** Returns a host whose interactor throws Cancellation/TurnCancelled. */
function makeCancellingHost(): HostAPI {
  return hostWithInteraction({
    raise: () =>
      Promise.reject(
        new Cancellation("user dismissed prompt", undefined, { code: "TurnCancelled" }),
      ),
  });
}

/** Returns a host whose interactor throws ToolTransient/ExecutionTimeout. */
function makeTimeoutHost(): HostAPI {
  return hostWithInteraction({
    raise: () =>
      Promise.reject(
        new ToolTransient("interaction timed out", undefined, { code: "ExecutionTimeout" }),
      ),
  });
}

const signal = new AbortController().signal;

// ---------------------------------------------------------------------------
// Shape / contract declaration
// ---------------------------------------------------------------------------

describe("ask-user tool — shape", () => {
  it("declares Tool category", () => {
    assert.equal(contract.kind, "Tool");
  });

  it("registers under manifestKey 'ask-user'", () => {
    assert.equal(contract.discoveryRules.manifestKey, "ask-user");
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
// Approval key stability (, Q-8 resolution)
// ---------------------------------------------------------------------------

describe("ask-user tool — deriveApprovalKey", () => {
  it("returns the fixed 'ask-user' key for any prompt", () => {
    assert.equal(contract.deriveApprovalKey({ prompt: "anything" }), "ask-user");
    assert.equal(contract.deriveApprovalKey({ prompt: "other" }), "ask-user");
  });

  it("returns the same key regardless of optional args", () => {
    const keyA = contract.deriveApprovalKey({ prompt: "q" });
    const keyB = contract.deriveApprovalKey({
      prompt: "q",
      placeholder: "hint",
      defaultValue: "default",
    });
    assert.equal(keyA, keyB);
    assert.equal(keyA, "ask-user");
  });
});

// ---------------------------------------------------------------------------
// Execute — happy path
// ---------------------------------------------------------------------------

describe("ask-user tool — execute success", () => {
  it("dispatches an Ask request and returns the answer", async () => {
    const host = makeAnsweringHost("the answer");
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({ prompt: "what?" }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.answer, "the answer");
      assert.equal(result.value.cancelled, false);
    }
  });

  it("forwards the prompt text to the interactor", async () => {
    let capturedPrompt = "";
    const host = hostWithInteraction({
      raise: (req) => {
        capturedPrompt = req.prompt;
        return Promise.resolve({ value: "ok" });
      },
    });
    await contract.lifecycle.init!(host, {});
    await contract.execute({ prompt: "tell me something" }, host, signal);

    assert.equal(capturedPrompt, "tell me something");
  });

  it("uses the interaction 'input' kind", async () => {
    let capturedKind = "";
    const host = hostWithInteraction({
      raise: (req) => {
        capturedKind = req.kind;
        return Promise.resolve({ value: "response" });
      },
    });
    await contract.lifecycle.init!(host, {});
    await contract.execute({ prompt: "q?" }, host, signal);

    assert.equal(capturedKind, "input");
  });
});

// ---------------------------------------------------------------------------
// Execute — error paths
// ---------------------------------------------------------------------------

describe("ask-user tool — execute error paths", () => {
  it("empty prompt → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "ask-user" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({ prompt: "" }, host, signal);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "InputInvalid");
    }
  });

  it("whitespace-only prompt → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "ask-user" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute({ prompt: "   " }, host, signal);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "InputInvalid");
    }
  });

  it("user cancels → Cancellation/TurnCancelled (thrown, not enveloped)", async () => {
    const host = makeCancellingHost();
    await contract.lifecycle.init!(host, {});

    await assert.rejects(
      () => contract.execute({ prompt: "q?" }, host, signal),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "Cancellation");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "TurnCancelled");
        return true;
      },
    );
  });

  it("timeout → ToolTransient/ExecutionTimeout (returned in envelope)", async () => {
    const host = makeTimeoutHost();
    await contract.lifecycle.init!(host, { timeoutMs: 5 });

    const result = await contract.execute({ prompt: "q?" }, host, signal);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTransient");
      assert.equal(result.error.context["code"], "ExecutionTimeout");
    }
  });

  it("forwards configured timeoutMs to the interactor", async () => {
    let capturedTimeout: number | undefined;
    const host = hostWithInteraction({
      raise: (req) => {
        capturedTimeout = req.timeoutMs;
        return Promise.resolve({ value: "ok" });
      },
    });
    await contract.lifecycle.init!(host, { timeoutMs: 3000 });
    await contract.execute({ prompt: "q?" }, host, signal);

    assert.equal(capturedTimeout, 3000);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("ask-user tool — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "ask-user" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs init then dispose without error", async () => {
    const { host } = mockHost({ extId: "ask-user" });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });

  it("dispose after dispose does not throw", async () => {
    const { host } = mockHost({ extId: "ask-user" });
    await contract.lifecycle.init!(host, {});
    await contract.lifecycle.dispose!(host);
    // Second dispose must be safe
    await contract.lifecycle.dispose!(host);
  });
});
