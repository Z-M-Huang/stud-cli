/**
 * `host.session.openChild()` implementation.
 *
 * Restricted entry point — only the bundled `delegate` tool may invoke this
 * (validation pipeline rejection at runtime). Wiki:
 * core/Host-API.md §session.openChild and core/Subagent-Sessions.md §Identity
 * and lifecycle.
 *
 * Validation order matches the wiki Delegate-Tool §Validation order verbatim:
 *
 *   1. Depth cap            → Subagent/DepthExceeded   (no IP fires)
 *   2. Model resolution     → Subagent/ModelInvalid    (no IP fires)
 *      and capability check → Subagent/ModelCapabilityMismatch (no IP fires)
 *   3. Envelope subset      → Subagent/EnvelopeInvalid (no IP fires)
 *   4. Mint subagentId; register `Requested` in SessionSubagentRegistry
 *   5. Raise approveSubagentEnvelope IP request
 *      headless without --yolo → emit-and-halt; child not opened
 *   6. On approve  → emit SubagentSpawned + run child  → emit terminal
 *   7. On deny     → emit SubagentEnvelopeDenied      → return
 *
 * The bundled `delegate` tool's preflight (Phase F) performs steps 1–3
 * defensively as well, so we get layered validation: the tool rejects bad
 * args early, and `openChild` re-validates before opening any session.
 */

import { randomUUID } from "node:crypto";

import { ToolTerminal } from "../errors/index.js";
import { Validation } from "../errors/validation.js";

import { validateRequestedEnvelope } from "./envelope.js";
import { buildSubagentRecord } from "./registry.js";

import type { SessionSubagentRegistry } from "./registry.js";
import type {
  SubagentEnvelope,
  SubagentModelSelection,
  SubagentRecord,
} from "../../contracts/subagent.js";
import type { OpenChildArgs, OpenChildResult } from "../host/api/session.js";

/**
 * Forbidden-source patterns mirrored from `core/context/forbidden-source-guard.ts`.
 * The child's transcript must enforce LLM Context Isolation (invariant #2)
 * AT THE PROVIDER REQUEST BOUNDARY — so the orchestrator-supplied `prompt`
 * arg is screened here before it lands in the child's transcript. Wiki:
 * security/LLM-Context-Isolation.md (1.1.0) §Subagent prompt isolation.
 */
const FORBIDDEN_PROMPT_PATTERNS: readonly { readonly id: string; readonly re: RegExp }[] = [
  { id: "anthropic-api-key", re: /\bsk-ant-[\w-]+\b/u },
  { id: "openai-api-key", re: /\bsk-[\w-]+\b/u },
  { id: "github-pat", re: /\bghp_\w+\b/u },
  { id: "google-api-key", re: /\bAIza[\w-]{20,}\b/u },
];

function assertPromptNotForbidden(prompt: string): void {
  for (const pattern of FORBIDDEN_PROMPT_PATTERNS) {
    if (pattern.re.test(prompt)) {
      throw new Validation(
        `delegate.prompt contains forbidden source material (${pattern.id}). Per LLM Context Isolation (wiki/security/LLM-Context-Isolation.md), credentials and env-shaped material must not enter the child's transcript.`,
        undefined,
        {
          code: "ContextContainsForbiddenSource",
          patternId: pattern.id,
          source: "delegate.prompt",
        },
      );
    }
  }
}

export interface ProviderModelLookup {
  /**
   * Returns true when the provider id is known to the session's loaded
   * providers configuration (per layered settings.json `providers` map).
   */
  hasProvider(providerId: string): boolean;
  /**
   * Returns true when the modelId is configured under the given provider's
   * `models[]` list.
   */
  hasModel(providerId: string, modelId: string): boolean;
  /**
   * Returns true when the (providerId, modelId) pair satisfies the
   * subagent's required capability set inherited from the parent. At
   * minimum, `toolCalling: hard` is required when the envelope is non-empty
   * per Capability-Negotiation.md §Required capabilities. Additional
   * capabilities the parent declared as required also flow into this check.
   */
  satisfiesRequiredCapabilities(providerId: string, modelId: string, envelopeSize: number): boolean;
}

export interface OpenChildContext {
  readonly parentSessionId: string;
  readonly parentDepth: number;
  readonly maxDepth: number;
  readonly parentModel: SubagentModelSelection;
  readonly activeToolNames: readonly string[];
  readonly registry: SessionSubagentRegistry;
  readonly providerModelLookup: ProviderModelLookup;
  readonly now: () => number;
  /**
   * Drives the child session — implements the `approveSubagentEnvelope` IP
   * round-trip and runs the child turn loop. Returns the terminal state.
   * Phase E iteration: when the runtime is ready, `runChildSession` from
   * src/core/subagent/run-child.ts is the implementation; tests inject a
   * stub.
   */
  readonly runChild: (input: SpawnedChildInput) => Promise<OpenChildResult>;
}

export interface SpawnedChildInput {
  readonly record: SubagentRecord;
  readonly prompt: string;
}

interface ResolveModelResult {
  readonly ok: true;
  readonly model: SubagentModelSelection;
}

interface DenyResult {
  readonly denied: ToolTerminal;
}

function resolveModel(
  ctx: OpenChildContext,
  args: OpenChildArgs,
  envelopeSize: number,
): ResolveModelResult | DenyResult {
  const providerId = args.model?.providerId ?? ctx.parentModel.providerId;
  // The `delegate` tool's input schema enforces `modelId` is required when
  // the `model` arg is present. The schema-level rejection emits
  // `Validation/InputInvalid` upstream; here we only see well-formed shapes,
  // but defend against direct-call misuse just in case.
  if (args.model !== undefined && (args.model.modelId === undefined || args.model.modelId === "")) {
    return {
      denied: new ToolTerminal(
        "delegate.model.modelId is required when `model` is present",
        undefined,
        { code: "Validation/InputInvalid" },
      ),
    };
  }
  const modelId = args.model?.modelId ?? ctx.parentModel.modelId;

  if (!ctx.providerModelLookup.hasProvider(providerId)) {
    return {
      denied: new ToolTerminal(
        `subagent model.providerId '${providerId}' is not loaded in settings.json`,
        undefined,
        { code: "Subagent/ModelInvalid", providerId, modelId },
      ),
    };
  }
  if (!ctx.providerModelLookup.hasModel(providerId, modelId)) {
    return {
      denied: new ToolTerminal(
        `subagent model.modelId '${modelId}' is not in provider '${providerId}' models[]`,
        undefined,
        { code: "Subagent/ModelInvalid", providerId, modelId },
      ),
    };
  }
  if (!ctx.providerModelLookup.satisfiesRequiredCapabilities(providerId, modelId, envelopeSize)) {
    return {
      denied: new ToolTerminal(
        `subagent model '${providerId}/${modelId}' does not satisfy the required capability set`,
        undefined,
        { code: "Subagent/ModelCapabilityMismatch", providerId, modelId, envelopeSize },
      ),
    };
  }
  return { ok: true, model: { providerId, modelId } };
}

/**
 * Pure validation surface. Used by both `openChild` and `delegate`'s
 * preflight (Phase F). Returns the canonical inputs for spawn or a typed
 * denial.
 *
 * No IP fires on any deny path. Mint of `subagentId` and registration with
 * the registry happen only after this returns success.
 */
export interface ValidatedSpawnInput {
  readonly model: SubagentModelSelection;
  readonly envelope: SubagentEnvelope;
  readonly depth: number;
}

export function validateSpawnArgs(
  ctx: OpenChildContext,
  args: OpenChildArgs,
): { readonly ok: true; readonly input: ValidatedSpawnInput } | DenyResult {
  // Step 0 — LLM Context Isolation (wiki/security/LLM-Context-Isolation.md
  // 1.1.0 §Subagent prompt isolation). The orchestrator-supplied `prompt`
  // is treated as untrusted user-source material; reject before any IP
  // fires so credential-shaped tokens cannot leak into the child.
  try {
    assertPromptNotForbidden(args.prompt);
  } catch (err) {
    if (err instanceof Validation) {
      const code =
        typeof err.context["code"] === "string"
          ? err.context["code"]
          : "ContextContainsForbiddenSource";
      return {
        denied: new ToolTerminal(err.message, err, { code }),
      };
    }
    throw err;
  }

  // Step 1 — depth cap.
  if (ctx.parentDepth >= ctx.maxDepth) {
    return {
      denied: new ToolTerminal(
        `subagent depth ${ctx.parentDepth + 1} exceeds maxDepth ${ctx.maxDepth}`,
        undefined,
        {
          code: "Subagent/DepthExceeded",
          requestedDepth: ctx.parentDepth + 1,
          maxDepth: ctx.maxDepth,
        },
      ),
    };
  }

  const requestedSize = args.requestedEnvelope?.length ?? 0;

  // Step 2 — model resolution + capability.
  const modelResult = resolveModel(ctx, args, requestedSize);
  if ("denied" in modelResult) return { denied: modelResult.denied };

  // Step 3 — envelope subset.
  const envelopeResult = validateRequestedEnvelope({
    requestedEnvelope: args.requestedEnvelope,
    activeToolNames: ctx.activeToolNames,
  });
  if ("denied" in envelopeResult) return { denied: envelopeResult.denied };

  return {
    ok: true,
    input: {
      model: modelResult.model,
      envelope: envelopeResult.envelope,
      depth: ctx.parentDepth + 1,
    },
  };
}

/**
 * Implementation of `host.session.openChild()`. Wires the validation order,
 * registry registration, and child-session invocation.
 */
export async function openChild(
  ctx: OpenChildContext,
  args: OpenChildArgs,
): Promise<OpenChildResult> {
  const validated = validateSpawnArgs(ctx, args);
  if ("denied" in validated) {
    // No IP fires; surface a typed result to the caller.
    const code = validated.denied.context["code"];
    const reason = mapValidationCodeToAbortReason(typeof code === "string" ? code : "");
    return {
      outcome: "aborted",
      subagentId: "",
      reason,
    };
  }

  // Step 4 — mint subagentId, register in `Requested`.
  const subagentId = randomUUID();
  const spawnedAt = ctx.now();
  const record = buildSubagentRecord({
    subagentId,
    parentSessionId: ctx.parentSessionId,
    depth: validated.input.depth,
    model: validated.input.model,
    approvedEnvelope: validated.input.envelope,
    ...(args.label !== undefined ? { label: args.label } : {}),
    spawnedAt,
  });
  ctx.registry.spawn(record);

  try {
    // Steps 5–7: the IP round-trip, child session loop, and terminal
    // emission are the runChild closure's responsibility. It returns the
    // shaped OpenChildResult.
    return await ctx.runChild({ record, prompt: args.prompt });
  } finally {
    ctx.registry.terminate(subagentId);
  }
}

function mapValidationCodeToAbortReason(code: string): OpenChildResult & {
  outcome: "aborted";
} extends {
  reason: infer R;
}
  ? R
  : never {
  // Map typed-error code → public abort reason on the `delegate` result.
  switch (code) {
    case "Subagent/DepthExceeded":
      return "depthExceeded";
    case "Subagent/EnvelopeInvalid":
      return "envelopeInvalid";
    case "Subagent/ModelInvalid":
      return "modelInvalid";
    case "Subagent/ModelCapabilityMismatch":
      return "modelCapabilityMismatch";
    default:
      return "providerFailure";
  }
}
