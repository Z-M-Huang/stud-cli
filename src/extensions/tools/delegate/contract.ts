/**
 * Contract declaration for the bundled `delegate` tool. Wiki:
 * reference-extensions/tools/Delegate-Tool.md and
 * core/Subagent-Sessions.md.
 *
 * Identity:
 *   - Name `delegate` (flat, no prefix).
 *   - In-tree (NOT from agentool) because it integrates with core's
 *     child-session machinery and the `approveSubagentEnvelope` IP kind.
 *   - Approval-gated. The spawn-time `approveSubagentEnvelope` IP is
 *     SEPARATE from the delegate-call approval — the user authorizes the
 *     envelope independently of authorizing the `delegate` invocation.
 *
 * `deriveApprovalKey` operates over `CanonicalDelegateArgs` (post-preflight)
 * so it stays pure-of-args per `contracts/Tools.md` §`deriveApprovalKey`
 * even though the resolved (providerId, modelId) appears in the key. See
 * D16 of /home/ubuntu/.claude/plans/ultrathink-we-have-a-magical-gem.md.
 */

import { delegateConfigSchema } from "./config.schema.js";
import { executeDelegate } from "./execute.js";
import { dispose, init } from "./lifecycle.js";

import type { CanonicalDelegateArgs, DelegateArgs } from "./args.js";
import type { DelegateConfig } from "./config.schema.js";
import type { DelegateResult } from "./result.js";
import type { ToolContract } from "../../../contracts/tools.js";

export const delegateInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: { type: "string", minLength: 1 },
    requestedEnvelope: { type: "array", items: { type: "string" }, default: [] },
    label: { type: "string" },
    model: {
      type: "object",
      additionalProperties: false,
      required: ["modelId"],
      properties: {
        providerId: { type: "string" },
        modelId: { type: "string" },
      },
    },
  },
} as const;

export const delegateOutputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
} as const;

/**
 * Compose the canonical approval key for a `delegate` call. Pure over the
 * post-preflight `CanonicalDelegateArgs`; the resolver passes canonicalArgs
 * (NOT the raw orchestrator-supplied args) so the (providerId, modelId)
 * fields are always populated. Wiki:
 * reference-extensions/tools/Delegate-Tool.md §Approval-key derivation.
 */
export function deriveDelegateApprovalKey(args: CanonicalDelegateArgs): string {
  const sortedEnvelope = [...args.requestedEnvelope].sort().join("+");
  return `delegate:provider=${args.model.providerId}:model=${args.model.modelId}:depth=${args.depth}:envelope=${sortedEnvelope}`;
}

export const contract: ToolContract<DelegateConfig, DelegateArgs, DelegateResult> = {
  kind: "Tool",
  contractVersion: "1.1.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: delegateConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "tools", manifestKey: "delegate" },
  reloadBehavior: "between-turns",
  inputSchema: delegateInputSchema,
  outputSchema: delegateOutputSchema,
  gated: true,
  // The contract's deriveApprovalKey signature is (args) => string. The
  // resolver routes preflight first; canonicalArgs (with populated `model`
  // and `depth`) is what flows into this function. Treating raw args as
  // CanonicalDelegateArgs is safe IFF the resolver applies preflight
  // canonicalization — see plan D16 + Phase F.
  deriveApprovalKey: (args: DelegateArgs): string => {
    const canonical = args as CanonicalDelegateArgs;
    if (canonical.model === undefined || typeof canonical.depth !== "number") {
      // Reaching this path indicates a runtime invariant violation: the
      // resolver MUST canonicalize args via preflight before calling
      // deriveApprovalKey. Throwing surfaces the misuse loudly rather than
      // returning a placeholder string that bypasses approval gating.
      throw new Error(
        "delegate.deriveApprovalKey called with non-canonical args; preflight must run first",
      );
    }
    return deriveDelegateApprovalKey(canonical);
  },
  execute: executeDelegate,
};
