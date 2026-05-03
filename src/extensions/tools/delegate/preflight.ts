/**
 * Pre-approval validator for the bundled `delegate` tool. Wiki:
 * reference-extensions/tools/Delegate-Tool.md §Validation order.
 *
 * Runs BEFORE `deriveApprovalKey` and BEFORE the resolver invokes the
 * approval gate. On success, returns `canonicalArgs` with `model.providerId`
 * + `model.modelId` populated and `depth` set so `deriveApprovalKey` can
 * stay pure-of-args (D16 of
 * /home/ubuntu/.claude/plans/ultrathink-we-have-a-magical-gem.md).
 *
 * On failure, returns a typed `ToolTerminal` — **no IP fires** in the deny
 * path. Per the wiki's "no IP fires on validation failure" rule.
 */

import { ToolTerminal } from "../../../core/errors/index.js";
import { validateSpawnArgs, type ProviderModelLookup } from "../../../core/subagent/spawn.js";

import { getConfig } from "./lifecycle.js";

import type { CanonicalDelegateArgs, DelegateArgs } from "./args.js";
import type { ToolPreflightContext, ToolPreflightResult } from "../../../cli/runtime/types.js";

/**
 * Adapt the runtime's ToolPreflightContext into the shape `validateSpawnArgs`
 * expects. The runtime supplies `parentProviderId`, `parentModelId`, and
 * `activeToolNames`; we wrap them with a lookup that the runtime can later
 * back with the loaded providers configuration.
 *
 * For the v1 wiring the lookup is permissive: any provider/model the host
 * exposes is accepted, and the capability check is satisfied as long as
 * `toolCalling: hard` is not falsified by the parent. The runtime adapter
 * provides a richer lookup once Phase E's child-session integration lands.
 */
function buildLookupFromCtx(ctx: ToolPreflightContext): ProviderModelLookup {
  // When the runtime supplies a settings-backed lookup, use it. Otherwise
  // fall back to a parent-only permissive lookup so unit tests / harnesses
  // without `settings.json` continue to exercise the deny path through the
  // parent-provider invariant.
  if (ctx.providerModelLookup !== undefined) return ctx.providerModelLookup;
  return {
    hasProvider(providerId) {
      return providerId === ctx.parentProviderId;
    },
    hasModel(_providerId, modelId) {
      return typeof modelId === "string" && modelId.length > 0;
    },
    satisfiesRequiredCapabilities() {
      return true;
    },
  };
}

export function preflight(
  rawArgs: unknown,
  ctx: ToolPreflightContext,
): Promise<ToolPreflightResult> {
  const config = getConfig();
  if (!config.enabled) {
    return Promise.resolve({
      denied: new ToolTerminal("delegate tool is disabled in this session", undefined, {
        code: "Forbidden",
      }),
    });
  }

  const args = rawArgs as DelegateArgs;
  if (typeof args.prompt !== "string" || args.prompt.length === 0) {
    return Promise.resolve({
      denied: new ToolTerminal(
        "delegate.prompt is required and must be a non-empty string",
        undefined,
        {
          code: "Validation/InputInvalid",
        },
      ),
    });
  }
  if (args.model !== undefined && typeof args.model.modelId !== "string") {
    return Promise.resolve({
      denied: new ToolTerminal(
        "delegate.model.modelId is required when `model` is present",
        undefined,
        { code: "Validation/InputInvalid" },
      ),
    });
  }

  // Honor a runtime-supplied maxDepth (from layered settings) when present,
  // otherwise fall back to the bundled lifecycle config (which itself reads
  // settings on init when the runtime calls `init`). Wiki:
  // reference-extensions/tools/Delegate-Tool.md §Config.
  const effectiveMaxDepth = ctx.maxDepth ?? config.maxDepth;
  const validated = validateSpawnArgs(
    {
      parentSessionId: "<unused-in-preflight>",
      parentDepth: ctx.currentDepth,
      maxDepth: effectiveMaxDepth,
      parentModel: { providerId: ctx.parentProviderId, modelId: ctx.parentModelId },
      activeToolNames: ctx.activeToolNames,
      registry: {
        spawn: () => undefined,
        transition: () => undefined,
        terminate: () => undefined,
        list: () => [],
        get: () => undefined,
        size: () => 0,
      },
      providerModelLookup: buildLookupFromCtx(ctx),
      now: () => Date.now(),
      runChild: () =>
        Promise.reject(
          new ToolTerminal("preflight does not run the child", undefined, { code: "Forbidden" }),
        ),
    },
    {
      prompt: args.prompt,
      ...(args.requestedEnvelope !== undefined
        ? { requestedEnvelope: args.requestedEnvelope }
        : {}),
      ...(args.label !== undefined ? { label: args.label } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
    },
  );

  if ("denied" in validated) {
    // Map typed Subagent/* errors to the wiki delegate output shape
    // `{aborted: { reason, subagentId }}` via earlyReturn so the LLM sees a
    // structured tool result, not a tool error. Wiki:
    // reference-extensions/tools/Delegate-Tool.md §Output schema.
    const code =
      typeof validated.denied.context["code"] === "string" ? validated.denied.context["code"] : "";
    const reason = mapDenialCodeToAbortReason(code);
    if (reason !== null) {
      return Promise.resolve({ earlyReturn: { aborted: { reason, subagentId: "" } } });
    }
    return Promise.resolve({ denied: validated.denied });
  }

  const canonical: CanonicalDelegateArgs = {
    prompt: args.prompt,
    requestedEnvelope: validated.input.envelope,
    ...(args.label !== undefined ? { label: args.label } : {}),
    model: validated.input.model,
    depth: validated.input.depth,
  };
  return Promise.resolve({ ok: true, canonicalArgs: canonical });
}

function mapDenialCodeToAbortReason(
  code: string,
): "depthExceeded" | "envelopeInvalid" | "modelInvalid" | "modelCapabilityMismatch" | null {
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
      return null;
  }
}
