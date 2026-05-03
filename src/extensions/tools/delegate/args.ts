/**
 * Input shape for the bundled `delegate` tool. Wiki:
 * reference-extensions/tools/Delegate-Tool.md §Input schema.
 *
 * The orchestrator-facing shape is `DelegateArgs`. The preflight validator
 * (preflight.ts) canonicalizes this into `CanonicalDelegateArgs` by filling
 * in `model` (always populated; defaults to parent's `(providerId, modelId)`)
 * and `depth` (the subagent's depth = parent's depth + 1).
 *
 * `deriveApprovalKey` operates over `CanonicalDelegateArgs` so the function
 * stays pure-of-args per `contracts/Tools.md` §`deriveApprovalKey` while
 * still encoding the resolved (providerId, modelId) per
 * Subagent-Sessions.md §Model selection (1.1.0).
 */

export interface DelegateArgs {
  readonly prompt: string;
  readonly requestedEnvelope?: readonly string[];
  readonly label?: string;
  readonly model?: { readonly providerId?: string; readonly modelId: string };
}

export interface CanonicalDelegateArgs {
  readonly prompt: string;
  readonly requestedEnvelope: readonly string[];
  readonly label?: string;
  readonly model: { readonly providerId: string; readonly modelId: string };
  readonly depth: number;
}
