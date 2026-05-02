/**
 * Helpers extracted from `swap-commands.ts` to keep the swap orchestration
 * focused. Each helper is single-purpose and side-effect-explicit.
 */
import { assertProviderParamsValid } from "../../contracts/provider-params.js";
import { anthropicHasContextManagement } from "../../extensions/providers/anthropic/native-params.js";

import { validatePerProtocolParams } from "./params-validator.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { ParamsRuntimeStore } from "./params-runtime.js";
import type {
  AnyProviderConfig,
  ProviderEntryId,
  ProviderProtocolId,
  ProviderSelection,
} from "./types.js";
import type { ProviderCapability } from "../../core/errors/index.js";

export interface ResolvedTarget {
  readonly entryId: ProviderEntryId;
  readonly protocolId: ProviderProtocolId;
  readonly config: AnyProviderConfig;
  readonly modelId: string;
}

export interface SwapAuditDeps {
  readonly auditBus: SessionAuditBus;
}

export interface ParamsAffectedEntry {
  readonly paramPath: readonly string[];
  readonly reason: string;
  readonly activeModelId: string;
  readonly currentValue: unknown;
  readonly sourceLayer: "defaultParams" | "launch" | "/params";
}

/**
 * Provider-Params validation prelude. Validates the **effective merged bag**
 * (`target.defaultParams ← --param ← /params`) for the destination
 * `(providerId, modelId)` and emits `DoubleCompactionConfigured` when an
 * Anthropic entry sets `contextManagement` alongside core compaction.
 * Throws `Validation` on hard-failure diagnostics so cross-protocol
 * overrides like `effort` (Anthropic) → OpenAI surface as `ParamUnknown`
 * BEFORE the target is published.
 */
export function validateTargetAndDiagnose(
  deps: SwapAuditDeps,
  target: ResolvedTarget,
  effectiveBag: Readonly<Record<string, unknown>>,
): void {
  const paramReport = validatePerProtocolParams({
    protocol: target.protocolId,
    params: effectiveBag,
    modelId: target.modelId,
    sourceLayer: "defaultParams",
  });
  assertProviderParamsValid(paramReport, {
    entryId: target.entryId,
    protocol: target.protocolId,
    modelId: target.modelId,
  });

  if (target.protocolId === "anthropic" && anthropicHasContextManagement(effectiveBag)) {
    deps.auditBus.emit("DoubleCompactionConfigured", {
      providerId: target.entryId,
      modelId: target.modelId,
      message:
        "Anthropic contextManagement is configured alongside core compaction; core wins on persistence",
    });
  }
}

/**
 * Compute the `paramsAffected[]` enrichment for the destination
 * `(providerId, modelId)` from the runtime store with `sourceLayer`
 * provenance. Per `wiki/contracts/Provider-Params.md` § "Capability-mismatch
 * behavior" Case B and `wiki/core/Event-Bus.md:122,174`.
 */
export function computeParamsAffected(
  store: ParamsRuntimeStore,
  target: ResolvedTarget,
): readonly ParamsAffectedEntry[] {
  const paramsReport = validatePerProtocolParams({
    protocol: target.protocolId,
    params: store.asMergedBag(),
    modelId: target.modelId,
    sourceLayer: "defaultParams",
  });
  return paramsReport.warnings
    .filter((w) => w.code === "ParamUnsupportedOnActive")
    .map((w) => {
      // Read provenance and value at the EXACT leaf path the warning names —
      // not the top-level entry — so nested params (e.g.,
      // `thinkingConfig.thinkingLevel`) report their own sourceLayer.
      const entry = store.get(w.paramPath);
      return {
        paramPath: w.paramPath,
        reason: w.message,
        activeModelId: target.modelId,
        currentValue: entry?.value ?? null,
        sourceLayer: entry?.sourceLayer ?? "defaultParams",
      } as const;
    });
}

/**
 * Emit Rejected audit + CapabilityMismatch on negotiation failure. Returns
 * the `rejected` swap reason; the holder + revisionId stay untouched.
 */
export function emitNegotiationRejected(
  deps: SwapAuditDeps,
  target: ResolvedTarget,
  previous: ProviderSelection,
  error: ProviderCapability,
  paramsAffected: readonly ParamsAffectedEntry[],
  protocolChanged: boolean,
): { readonly code: string; readonly message: string } {
  const code =
    typeof error.context["code"] === "string" ? error.context["code"] : "MissingCapability";
  const reason = { code, message: error.message };
  if (protocolChanged) {
    deps.auditBus.emit("ProviderSwitchRejected", {
      from: previous.protocolId,
      to: target.protocolId,
      reason,
    });
  }
  deps.auditBus.emit("ModelSwitchRejected", {
    from: previous.modelId,
    to: target.modelId,
    providerId: target.entryId,
    reason,
  });
  if (paramsAffected.length > 0) {
    deps.auditBus.emit("CapabilityMismatch", {
      direction: protocolChanged ? "switch-into" : "switch-from",
      providerId: target.entryId,
      modelId: target.modelId,
      missingCapabilities: [reason.code],
      paramsAffected,
    });
  }
  return reason;
}
