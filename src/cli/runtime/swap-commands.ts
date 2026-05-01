import { join } from "node:path";

import Ajv from "ajv";

import { negotiate } from "../../core/capabilities/negotiator.js";
import { ProviderCapability, Validation } from "../../core/errors/index.js";
import { mergeSettings } from "../../core/settings/validator.js";

import { atomicWriteJson, loadSettingsFile, studHome } from "./storage.js";
import { PROTOCOLS } from "./types.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { RuntimeContextRegistry } from "./runtime-context-registry.js";
import type {
  AnyProviderConfig,
  ProviderEntryId,
  ProviderProtocolId,
  ProviderSelection,
  ResolvedShellDeps,
  SessionBootstrap,
  Settings,
} from "./types.js";
import type {
  CapabilityName,
  CapabilityRequirement,
  CapabilityVector,
} from "../../core/capabilities/negotiator.js";
import type { InteractionAPI } from "../../core/host/api/interaction.js";

export type SwapResult =
  | { readonly kind: "swapped"; readonly selection: ProviderSelection }
  | {
      readonly kind: "rejected";
      readonly reason: { readonly code: string; readonly message: string };
    }
  | { readonly kind: "noop"; readonly reason: string };

interface SwapDeps {
  readonly session: SessionBootstrap;
  readonly deps: ResolvedShellDeps;
  readonly auditBus: SessionAuditBus;
  readonly registry: RuntimeContextRegistry;
  readonly globalSettingsPath: string;
  readonly projectSettingsPath: string;
  /** Required capability vector for this session, computed from session state. */
  readonly requirements: readonly CapabilityRequirement[];
}

/**
 * Compute the required capability vector for a session from its live state.
 *
 * In v1 the only contributor is the optional attached State Machine; bundled
 * Hooks and Context Providers do not declare capability requirements, and the
 * security mode does not impose any. As more contributors land, extend this
 * function rather than hard-coding a baseline.
 *
 * Wiki: contracts/Capability-Negotiation.md.
 */
export function computeRequiredCapabilities(
  _session: SessionBootstrap,
): readonly CapabilityRequirement[] {
  // No SMs / Hooks / Context Providers declare requirements in v1; the
  // computed vector is empty. Callers may inject extra requirements at the
  // dispatch site for fixture-driven tests.
  return [];
}

function vectorFromCapabilities(
  capabilities: (typeof PROTOCOLS)[ProviderProtocolId]["contract"]["capabilities"],
): CapabilityVector {
  function levelToBoolean(level: string): boolean {
    return level === "hard" || level === "preferred";
  }
  return {
    streaming: levelToBoolean(capabilities.streaming),
    toolCalling: levelToBoolean(capabilities.toolCalling),
    structuredOutput: levelToBoolean(capabilities.structuredOutput),
    multimodal: levelToBoolean(capabilities.multimodal),
    reasoning: levelToBoolean(capabilities.reasoning),
    contextWindow: typeof capabilities.contextWindow === "number" ? capabilities.contextWindow : 0,
    promptCaching:
      capabilities.promptCaching === "probed"
        ? "probed"
        : levelToBoolean(capabilities.promptCaching),
  };
}

function validateProviderConfig(
  protocolId: ProviderProtocolId,
  entryId: ProviderEntryId,
  config: unknown,
): asserts config is AnyProviderConfig {
  const descriptor = PROTOCOLS[protocolId];
  const { $schema: _ignored, ...schema } = descriptor.contract.configSchema as Record<
    string,
    unknown
  >;
  const validate = new Ajv({ allErrors: true }).compile(schema);
  if (!validate(config)) {
    throw new Validation(
      `provider entry '${entryId}' (protocol '${protocolId}') failed schema validation`,
      undefined,
      {
        code: "ConfigSchemaViolation",
        entryId,
        protocolId,
        errors: validate.errors ?? [],
      },
    );
  }
}

async function readMergedSettings(deps: SwapDeps): Promise<Settings> {
  const global = (await loadSettingsFile(deps.globalSettingsPath)) ?? {};
  const project = await loadSettingsFile(deps.projectSettingsPath);
  return mergeSettings(undefined, global, project) as Settings;
}

interface ResolvedTarget {
  readonly entryId: ProviderEntryId;
  readonly protocolId: ProviderProtocolId;
  readonly config: AnyProviderConfig;
  readonly modelId: string;
}

function isProtocolId(value: unknown): value is ProviderProtocolId {
  return typeof value === "string" && value in PROTOCOLS;
}

function resolveProviderTarget(
  settings: Settings,
  entryId: ProviderEntryId,
  preferredModel: string | undefined,
): ResolvedTarget {
  const providers = (settings.providers ?? {}) as Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  const raw = providers[entryId];
  if (raw === undefined) {
    throw new Validation(`provider entry '${entryId}' is not configured`, undefined, {
      code: "UnknownConfigKey",
      entryId,
    });
  }
  const protocol = (raw as { protocol?: unknown }).protocol;
  if (!isProtocolId(protocol)) {
    throw new Validation(
      `provider entry '${entryId}' has unknown or missing 'protocol' field`,
      undefined,
      { code: "UnknownProtocol", entryId, protocol },
    );
  }

  validateProviderConfig(protocol, entryId, raw);
  const config = raw as unknown as AnyProviderConfig;
  const models = (config as { readonly models: readonly [string, ...string[]] }).models;
  const modelId =
    preferredModel !== undefined && models.includes(preferredModel) ? preferredModel : models[0];
  return { entryId, protocolId: protocol, config, modelId };
}

function resolveModelTarget(current: ProviderSelection, modelName: string): ResolvedTarget {
  const models = (current.config as { readonly models: readonly [string, ...string[]] }).models;
  if (!models.includes(modelName)) {
    throw new Validation(
      `model '${modelName}' is not declared in provider entry '${current.entryId}'`,
      undefined,
      {
        code: "ModelNotInProvider",
        entryId: current.entryId,
        model: modelName,
        models,
      },
    );
  }
  return {
    entryId: current.entryId,
    protocolId: current.protocolId,
    config: current.config,
    modelId: modelName,
  };
}

async function persistActiveSelection(
  deps: SwapDeps,
  entryId: ProviderEntryId,
  modelId: string,
): Promise<void> {
  const current = (await loadSettingsFile(deps.globalSettingsPath)) ?? {};
  const next: Settings = {
    ...current,
    active: { ...(current.active ?? {}), provider: entryId, model: modelId },
  };
  await atomicWriteJson(deps.globalSettingsPath, next);
}

/**
 * Run the transactional swap sequence (steps 1-9 from the plan). On capability
 * mismatch or persist failure the holder is left untouched and a typed error
 * is returned via the `rejected` arm. On success the selection is published
 * and audited.
 */
async function performSwap(deps: SwapDeps, target: ResolvedTarget): Promise<SwapResult> {
  const previous = deps.session.selection.current();
  const protocolChanged = target.protocolId !== previous.protocolId;
  const entryChanged = target.entryId !== previous.entryId;

  // Step 4-5: capability negotiation against the contract's static claims.
  const advertised = vectorFromCapabilities(PROTOCOLS[target.protocolId].contract.capabilities);
  try {
    negotiate(deps.requirements, advertised);
  } catch (error) {
    if (error instanceof ProviderCapability) {
      const code =
        typeof error.context["code"] === "string" ? error.context["code"] : "MissingCapability";
      const reason = { code, message: error.message };
      // Step 6: emit Rejected audit; leave holder + revisionId untouched.
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
      return { kind: "rejected", reason };
    }
    throw error;
  }

  // Step 7: two-phase prepare. Allocate or reuse the target entry's runtime
  // context. For a brand-new entryId this runs the new context's init+activate
  // before any teardown; same-entry re-selection (model-only swap) is a no-op.
  const prepared = await deps.registry.ensure({
    entryId: target.entryId,
    protocolId: target.protocolId,
    config: target.config,
  });

  // Persist `active.*` BEFORE publishing so a write failure leaves the
  // session untouched. On failure dispose any newly-allocated context.
  try {
    await persistActiveSelection(deps, target.entryId, target.modelId);
  } catch (error) {
    if (entryChanged) {
      await deps.registry.dispose(target.entryId);
    }
    throw error;
  }

  // Step 8: publish.
  const next: ProviderSelection = {
    entryId: prepared.entryId,
    protocolId: prepared.protocolId,
    config: prepared.config,
    modelId: target.modelId,
  };
  deps.session.selection.swap(next);
  if (protocolChanged) {
    deps.auditBus.emit("ProviderSwitch", {
      from: previous.protocolId,
      to: target.protocolId,
    });
  }
  deps.auditBus.emit("ModelSwitch", {
    from: previous.modelId,
    to: target.modelId,
    providerId: target.entryId,
  });

  return { kind: "swapped", selection: next };
}

function modelOptions(current: ProviderSelection): readonly string[] {
  return (current.config as { readonly models: readonly [string, ...string[]] }).models;
}

export interface SwapCommandDeps {
  readonly session: SessionBootstrap;
  readonly deps: ResolvedShellDeps;
  readonly interaction: InteractionAPI;
  readonly auditBus: SessionAuditBus;
  readonly registry: RuntimeContextRegistry;
  readonly projectRoot: string;
}

function swapDeps(deps: SwapCommandDeps): SwapDeps {
  return {
    session: deps.session,
    deps: deps.deps,
    auditBus: deps.auditBus,
    registry: deps.registry,
    globalSettingsPath: join(studHome(deps.deps.homedir()), "settings.json"),
    projectSettingsPath: join(deps.projectRoot, "settings.json"),
    requirements: computeRequiredCapabilities(deps.session),
  };
}

/**
 * `/provider [<id>]`. With no argument, opens a picker over all configured
 * provider entries; with `<id>`, swaps directly. Failure modes follow the swap
 * sequence: capability mismatch → rejected; missing entry → typed Validation;
 * persist failure → rethrow with no holder change.
 */
export async function dispatchProviderCommand(
  args: SwapCommandDeps,
  argument: string | undefined,
): Promise<SwapResult> {
  const sd = swapDeps(args);
  const settings = await readMergedSettings(sd);
  const providers = Object.keys(settings.providers ?? {});

  let entryId: ProviderEntryId;
  if (argument === undefined || argument.length === 0) {
    if (providers.length === 0) {
      return { kind: "noop", reason: "no provider entries are configured" };
    }
    const result = await args.interaction.raise({
      kind: "select",
      prompt: "Choose a provider entry",
      options: providers,
    });
    entryId = result.value;
  } else {
    entryId = argument;
  }

  const target = resolveProviderTarget(settings, entryId, settings.active?.model);
  return performSwap(sd, target);
}

/**
 * `/model [<name>]`. With no argument, opens a picker over the current
 * provider's `models[]`; with `<name>`, swaps directly within the current
 * provider.
 */
export async function dispatchModelCommand(
  args: SwapCommandDeps,
  argument: string | undefined,
): Promise<SwapResult> {
  const sd = swapDeps(args);
  const current = args.session.selection.current();

  let modelName: string;
  if (argument === undefined || argument.length === 0) {
    const result = await args.interaction.raise({
      kind: "select",
      prompt: "Choose a model",
      options: modelOptions(current),
    });
    modelName = result.value;
  } else {
    modelName = argument;
  }

  const target = resolveModelTarget(current, modelName);
  return performSwap(sd, target);
}

// `CapabilityName` is re-exported for swap-commands tests that build fixture
// requirement vectors from the same authority as the negotiator.
export type { CapabilityName };
