/**
 * Tool contract registry delegate.
 *
 * Provides a thin, in-memory registry from `toolId` to `ToolContract`.
 * The authority stack and the approval cache call
 * `lookupToolContract` before invoking `deriveApprovalKey` so that the full
 * contract is available without re-traversing the extension registry.
 *
 * Ownership:
 *   The `ToolContractRegistry` is populated at extension load time. Each tool
 *   that successfully loads registers itself via `registerToolContract`. The
 *   registry is read-only after the load phase.
 *
 * Error conditions:
 *   `ToolTerminal/ToolNotRegistered` — when `lookupToolContract` is called
 *   for an id that was never registered. Callers should treat this as a
 *   programming error: the TOOL_CALL stage should only dispatch to tool ids
 *   present in the registry.
 *
 * Wiki: contracts/Tools.md, security/Tool-Approvals.md
 */

import { ToolTerminal } from "../../errors/tool-terminal.js";

import type { ToolContract } from "../../../contracts/tools.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Mutable registration surface — used only during the extension load phase.
 * Once all extensions have loaded, callers should treat the registry as
 * read-only and access it only via `lookupToolContract`.
 */
export interface ToolContractRegistry {
  /**
   * Register a tool contract under `toolId`.
   * A second call with the same `toolId` overwrites the first; callers must
   * ensure that ids are unique across loaded extensions.
   */
  register(toolId: string, contract: ToolContract): void;

  /**
   * Look up a registered tool contract by id.
   *
   * @throws `ToolTerminal/ToolNotRegistered` when `toolId` has no entry.
   */
  lookup(toolId: string): ToolContract;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new, empty `ToolContractRegistry`.
 *
 * Returns a single object implementing both the registration surface and the
 * lookup surface. Production code wires this up once at bootstrap; tests
 * create a fresh instance per-case.
 */
export function createToolContractRegistry(): ToolContractRegistry {
  const entries = new Map<string, ToolContract>();

  return {
    register(toolId: string, contract: ToolContract): void {
      entries.set(toolId, contract);
    },

    lookup(toolId: string): ToolContract {
      const contract = entries.get(toolId);
      if (contract === undefined) {
        throw new ToolTerminal(
          `tool "${toolId}" is not registered in the tool contract registry`,
          undefined,
          { code: "ToolNotRegistered", toolId },
        );
      }
      return contract;
    },
  };
}
