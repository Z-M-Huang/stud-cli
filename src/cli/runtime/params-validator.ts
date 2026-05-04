/**
 * Cross-cutting Provider-Params validation helper.
 *
 * Bridges the per-adapter native-fields modules
 * (`src/extensions/providers/<vendor>/native-params.ts`) into the
 * canonical `validateProviderParams` pipeline at
 * `src/contracts/provider-params.ts`. Used by both the swap path
 * (`swap-commands.ts`) and the bootstrap path (`bootstrap.ts`).
 *
 * Wiki: contracts/Provider-Params.md § "Validation summary";
 *       contracts/Validation-Pipeline.md (`ParamUnsupportedOnActive` two flavors).
 */
import {
  assertProviderParamsValid,
  validateProviderParams,
  type ParamValidationDiagnostic,
  type ParamValidationReport,
} from "../../contracts/provider-params.js";
import {
  ANTHROPIC_NATIVE_FIELDS,
  ANTHROPIC_NATIVE_FIELD_SCHEMAS,
  anthropicActiveModelChecker,
  anthropicThinkingBudgetVsMaxOutput,
} from "../../extensions/providers/anthropic/native-params.js";
import {
  GEMINI_NATIVE_FIELDS,
  GEMINI_NATIVE_FIELD_SCHEMAS,
  geminiActiveModelChecker,
  geminiCrossFieldChecks,
} from "../../extensions/providers/gemini/native-params.js";
import {
  OPENAI_NATIVE_FIELDS,
  OPENAI_NATIVE_FIELD_SCHEMAS,
  openaiActiveModelChecker,
} from "../../extensions/providers/openai-compatible/native-params.js";

import { PROTOCOLS } from "./provider-protocols.js";

import type { ProviderProtocolId, Settings } from "./types.js";
import type { JSONSchemaObject } from "../../contracts/state-slot.js";

/**
 * Empty native-field set + no-op checks for protocols that don't enumerate a
 * native bucket (e.g., cli-wrapper). Param validation still runs the
 * `ParamForbiddenKey` and `ParamSecretValue` checks; the rest pass through.
 *
 * NOTE: this means cli-wrapper accepts an open `defaultParams` shape because
 * its protocol surface is process-shaped, not LLM-shaped. The
 * forbidden-key/secret-value rules still apply.
 */
const PERMISSIVE_NATIVE: ReadonlySet<string> = new Set();

interface ProtocolValidatorBindings {
  readonly nativeFields: ReadonlySet<string>;
  readonly nativeFieldSchemas?: JSONSchemaObject;
  readonly crossFieldChecks: readonly ((
    p: Readonly<Record<string, unknown>>,
  ) => Omit<ParamValidationDiagnostic, "code" | "severity"> | null)[];
  readonly buildActiveModelChecker?: (modelId: string) => (
    p: Readonly<Record<string, unknown>>,
  ) => readonly {
    readonly paramPath: readonly string[];
    readonly reason: string;
  }[];
  /** Skip strict-shape checks for protocols without a declared native bucket. */
  readonly permissive?: boolean;
}

const BINDINGS: Readonly<Record<ProviderProtocolId, ProtocolValidatorBindings>> = {
  anthropic: {
    nativeFields: ANTHROPIC_NATIVE_FIELDS,
    nativeFieldSchemas: ANTHROPIC_NATIVE_FIELD_SCHEMAS,
    crossFieldChecks: [anthropicThinkingBudgetVsMaxOutput],
    buildActiveModelChecker: anthropicActiveModelChecker,
  },
  "openai-compatible": {
    nativeFields: OPENAI_NATIVE_FIELDS,
    nativeFieldSchemas: OPENAI_NATIVE_FIELD_SCHEMAS,
    crossFieldChecks: [],
    buildActiveModelChecker: openaiActiveModelChecker,
  },
  gemini: {
    nativeFields: GEMINI_NATIVE_FIELDS,
    nativeFieldSchemas: GEMINI_NATIVE_FIELD_SCHEMAS,
    crossFieldChecks: [geminiCrossFieldChecks],
    buildActiveModelChecker: geminiActiveModelChecker,
  },
  "cli-wrapper": {
    nativeFields: PERMISSIVE_NATIVE,
    crossFieldChecks: [],
    permissive: true,
  },
};

export interface ValidatePerProtocolInput {
  readonly protocol: ProviderProtocolId;
  readonly params: Readonly<Record<string, unknown>>;
  readonly modelId: string;
  readonly sourceLayer?: "defaultParams" | "launch" | "/params";
}

/**
 * Run `validateProviderParams` for the given protocol + active model id.
 * Returns the report; callers decide whether to throw on errors.
 */
export function validatePerProtocolParams(input: ValidatePerProtocolInput): ParamValidationReport {
  const bindings = BINDINGS[input.protocol];
  const activeChecker = bindings.buildActiveModelChecker?.(input.modelId);
  return validateProviderParams({
    params: input.params,
    protocol: input.protocol,
    nativeFields: bindings.nativeFields,
    crossFieldChecks: bindings.crossFieldChecks,
    ...(bindings.nativeFieldSchemas !== undefined
      ? { nativeFieldSchemas: bindings.nativeFieldSchemas }
      : {}),
    ...(activeChecker !== undefined ? { activeModelChecker: activeChecker } : {}),
    ...(input.sourceLayer !== undefined ? { sourceLayer: input.sourceLayer } : {}),
    ...(bindings.permissive === true ? { permissive: true } : {}),
  });
}

/**
 * Run Provider-Params validation against an entry's `defaultParams` for a
 * specific `(providerId, modelId)` pair and throw on hard-failure
 * diagnostics. Used by both swap and bootstrap paths.
 */
export function validateAndAssertEntryParams(input: {
  readonly protocol: ProviderProtocolId;
  readonly entryId: string;
  readonly modelId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sourceLayer?: "defaultParams" | "launch" | "/params";
}): void {
  const report = validatePerProtocolParams({
    protocol: input.protocol,
    params: input.params,
    modelId: input.modelId,
    ...(input.sourceLayer !== undefined ? { sourceLayer: input.sourceLayer } : {}),
  });
  assertProviderParamsValid(report, {
    entryId: input.entryId,
    protocol: input.protocol,
    modelId: input.modelId,
  });
}

/**
 * Validate an entry's `defaultParams` against EVERY declared
 * `models[]` entry. Hard errors (ParamForbiddenKey, ParamSecretValue,
 * ParamWireShape, ParamUnknown, ParamReserved, ParamCrossFieldInvalid) are
 * union-deduped: any error on any model fails the entry. Warnings
 * (`ParamUnsupportedOnActive`) are grouped per-path with the affected
 * models list per `wiki/contracts/Provider-Params.md` § "Capability-mismatch
 * behavior" Case A.
 */
export function validateEntryAgainstAllModels(input: {
  readonly protocol: ProviderProtocolId;
  readonly entryId: string;
  readonly models: readonly string[];
  readonly params: Readonly<Record<string, unknown>>;
  readonly sourceLayer?: "defaultParams" | "launch" | "/params";
}): {
  readonly errors: readonly ParamValidationDiagnostic[];
  readonly groupedWarnings: readonly ParamValidationDiagnostic[];
} {
  const perModel: { modelId: string; report: ParamValidationReport }[] = [];
  const errorsSet = new Map<string, ParamValidationDiagnostic>();
  for (const modelId of input.models) {
    const report = validatePerProtocolParams({
      protocol: input.protocol,
      params: input.params,
      modelId,
      ...(input.sourceLayer !== undefined ? { sourceLayer: input.sourceLayer } : {}),
    });
    perModel.push({ modelId, report });
    for (const e of report.errors) {
      const key = `${e.code}|${e.paramPath.join(".")}`;
      if (!errorsSet.has(key)) errorsSet.set(key, e);
    }
  }
  return {
    errors: [...errorsSet.values()],
    groupedWarnings: groupUnsupportedOnActiveWarnings(perModel),
  };
}

/**
 * Group-and-merge per-model `ParamUnsupportedOnActive` warnings: when an
 * entry's `defaultParams` are validated against multiple `models[]` entries,
 * collapse warnings on the same `paramPath` into a single grouped warning
 * listing all affected models.
 *
 * Per `wiki/contracts/Provider-Params.md` § "Capability-mismatch behavior" Case A:
 *   "Load-time 'declared model may reject' — provider entry lists multiple
 *   models; value applies to some but not others. Informational; grouped at
 *   validation; emitted once per provider entry per offending param path."
 */
export interface ProviderEntryDiagnostics {
  readonly entryId: string;
  readonly errors: readonly ParamValidationDiagnostic[];
  readonly groupedWarnings: readonly ParamValidationDiagnostic[];
}

/**
 * Validate `defaultParams` for every configured provider entry against every
 * model declared by that entry. Returns the per-entry diagnostics so the
 * bootstrap surface can decide whether to disable entries, emit grouped
 * warnings, or fail startup. Per `wiki/contracts/Provider-Params.md` §
 * "Capability-mismatch behavior" Case A.
 */
export function validateAllProviderEntries(
  settings: Settings,
): readonly ProviderEntryDiagnostics[] {
  const providers = (settings.providers ?? {}) as Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  const out: ProviderEntryDiagnostics[] = [];
  for (const [entryId, raw] of Object.entries(providers)) {
    const protocol = (raw as { protocol?: unknown }).protocol;
    if (typeof protocol !== "string" || !(protocol in PROTOCOLS)) continue;
    const protocolId = protocol as ProviderProtocolId;
    const models = (raw as { models?: unknown }).models;
    if (!Array.isArray(models) || models.length === 0) continue;
    const params =
      (raw as { defaultParams?: Readonly<Record<string, unknown>> }).defaultParams ?? {};
    const result = validateEntryAgainstAllModels({
      protocol: protocolId,
      entryId,
      models: models as readonly string[],
      params,
      sourceLayer: "defaultParams",
    });
    out.push({ entryId, errors: result.errors, groupedWarnings: result.groupedWarnings });
  }
  return out;
}

/**
 * Emit per-entry diagnostics to a sink (typically `console.warn` at startup
 * before the audit bus is wired). Errors are reported but do NOT throw —
 * the active-entry hard assertion handles startup failure separately.
 */
export function reportProviderEntryDiagnostics(
  diagnostics: readonly ProviderEntryDiagnostics[],
  sink: (line: string) => void,
): void {
  for (const d of diagnostics) {
    for (const e of d.errors) {
      sink(`[${d.entryId}] ${e.code} at /${e.paramPath.join("/")}: ${e.message}`);
    }
    for (const w of d.groupedWarnings) {
      sink(`[${d.entryId}] WARN ${w.code} at /${w.paramPath.join("/")}: ${w.message}`);
    }
  }
}

export function groupUnsupportedOnActiveWarnings(
  perModelReports: readonly { readonly modelId: string; readonly report: ParamValidationReport }[],
): readonly ParamValidationDiagnostic[] {
  const grouped = new Map<
    string,
    { paramPath: readonly string[]; affectedModels: string[]; firstReason: string }
  >();
  for (const { modelId, report } of perModelReports) {
    for (const w of report.warnings) {
      if (w.code !== "ParamUnsupportedOnActive") continue;
      const key = w.paramPath.join(".");
      const existing = grouped.get(key);
      if (existing === undefined) {
        grouped.set(key, {
          paramPath: w.paramPath,
          affectedModels: [modelId],
          firstReason: w.message,
        });
      } else if (!existing.affectedModels.includes(modelId)) {
        existing.affectedModels.push(modelId);
      }
    }
  }
  return [...grouped.values()].map((g) => ({
    code: "ParamUnsupportedOnActive",
    paramPath: g.paramPath,
    severity: "warning",
    message: `${g.firstReason} (affected models: ${g.affectedModels.join(", ")})`,
    context: { affectedModels: g.affectedModels },
  }));
}
