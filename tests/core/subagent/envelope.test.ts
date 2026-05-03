import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateRequestedEnvelope } from "../../../src/core/subagent/envelope.js";

describe("validateRequestedEnvelope", () => {
  it("returns an empty envelope when none requested", () => {
    const result = validateRequestedEnvelope({
      requestedEnvelope: undefined,
      activeToolNames: ["read", "edit"],
    });
    if ("denied" in result) {
      assert.fail("expected ok");
      return;
    }
    assert.deepEqual(result.envelope, []);
  });

  it("accepts a strict subset of the active tool manifest", () => {
    const result = validateRequestedEnvelope({
      requestedEnvelope: ["read", "edit"],
      activeToolNames: ["read", "edit", "bash", "diff"],
    });
    if ("denied" in result) {
      assert.fail("expected ok");
      return;
    }
    // envelope is sorted for determinism (matches approval-key sort).
    assert.deepEqual(result.envelope, ["edit", "read"]);
  });

  it("rejects when any requested name is not loaded", () => {
    const result = validateRequestedEnvelope({
      requestedEnvelope: ["read", "ssh-tunnel"],
      activeToolNames: ["read", "edit"],
    });
    assert.equal("denied" in result, true);
    if (!("denied" in result)) return;
    assert.equal(result.denied.context["code"], "Subagent/EnvelopeInvalid");
  });

  it("dedupes duplicate envelope entries", () => {
    const result = validateRequestedEnvelope({
      requestedEnvelope: ["read", "read", "edit"],
      activeToolNames: ["read", "edit"],
    });
    if ("denied" in result) {
      assert.fail("expected ok");
      return;
    }
    assert.deepEqual([...result.envelope].sort(), ["edit", "read"]);
  });
});
