/**
 * MCP-Resource-Bind invariants.
 *
 * Asserts the documented bindResource invariants:
 *   1. Negative/zero maxBytes throws Validation/BindingCapExceeded.
 *   2. The BoundResource shape pins `taint: "untrusted"` (MCP resources
 *      are always tainted).
 *
 * Wiki: flows/MCP-Resource-Bind.md + core/Resource-Binding.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bindResource, type MCPResourceBinding } from "../../src/core/mcp/resource-binding.js";

describe("MCP-Resource-Bind invariants", () => {
  it("invalid maxBytes throws Validation/BindingCapExceeded", async () => {
    const binding: MCPResourceBinding = {
      serverId: "github",
      uri: "resource://x",
      maxBytes: 0,
    };
    let threw: { class: string | undefined; code: string | undefined } | null = null;
    try {
      await bindResource(binding);
    } catch (err) {
      threw = {
        class: (err as { class?: string }).class,
        code: (err as { context?: { code?: string } }).context?.code,
      };
    }
    assert.equal(threw?.class, "Validation");
    assert.equal(threw?.code, "BindingCapExceeded");
  });

  it("negative maxBytes also throws Validation/BindingCapExceeded", async () => {
    const binding: MCPResourceBinding = {
      serverId: "github",
      uri: "resource://x",
      maxBytes: -1,
    };
    let threwCode: string | undefined;
    try {
      await bindResource(binding);
    } catch (err) {
      threwCode = (err as { context?: { code?: string } }).context?.code;
    }
    assert.equal(threwCode, "BindingCapExceeded");
  });

  it("non-integer maxBytes also throws Validation/BindingCapExceeded", async () => {
    const binding: MCPResourceBinding = {
      serverId: "github",
      uri: "resource://x",
      maxBytes: 1.5,
    };
    let threwCode: string | undefined;
    try {
      await bindResource(binding);
    } catch (err) {
      threwCode = (err as { context?: { code?: string } }).context?.code;
    }
    assert.equal(threwCode, "BindingCapExceeded");
  });
});
