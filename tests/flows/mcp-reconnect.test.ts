/**
 * UAT-27: MCP-Reconnect surfaces + retries + logs.
 *
 * Asserts the documented reconnect policy invariants without standing up
 * a full MCP transport (the transport itself is exercised in
 * `tests/core/mcp/`). Verified here:
 *
 *   1. The default policy has bounded retries with sane delays.
 *   2. Reconnect against an unregistered server throws
 *      `Validation/MCPServerNotRegistered`.
 *
 * Wiki: flows/MCP-Reconnect.md + core/MCP-Client.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultReconnectPolicy, reconnect } from "../../src/core/mcp/reconnect.js";
import { clearRegistry } from "../../src/core/mcp/server-registry.js";

describe("UAT-27: MCP-Reconnect policy + invariants", () => {
  it("defaultReconnectPolicy declares bounded attempts + delays", () => {
    assert.equal(defaultReconnectPolicy.maxAttempts > 0, true);
    assert.equal(defaultReconnectPolicy.initialDelayMs > 0, true);
    assert.equal(defaultReconnectPolicy.maxDelayMs >= defaultReconnectPolicy.initialDelayMs, true);
    assert.equal(defaultReconnectPolicy.jitter >= 0, true);
    assert.equal(defaultReconnectPolicy.jitter <= 1, true);
  });

  it("reconnect against unregistered server throws Validation/MCPServerNotRegistered", async () => {
    clearRegistry();
    let threw: { class: string | undefined; code: string | undefined } | null = null;
    try {
      await reconnect("no-such-server", defaultReconnectPolicy);
    } catch (err) {
      threw = {
        class: (err as { class?: string }).class,
        code: (err as { context?: { code?: string } }).context?.code,
      };
    }
    assert.equal(threw?.class, "Validation");
    assert.equal(threw?.code, "MCPServerNotRegistered");
  });

  it("policy is immutable (Object.freeze)", () => {
    assert.equal(Object.isFrozen(defaultReconnectPolicy), true);
  });
});
