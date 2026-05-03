/**
 * Bootstrap helpers that build the per-session subagent scaffold and wire
 * the runtime closure for `host.session.openChild()`.
 *
 * Kept separate from `session-loop.ts` so the orchestrator stays focused
 * on the message loop and the file size stays under 500 lines per repo
 * lint policy.
 *
 * Wiki: core/Subagent-Sessions.md §Identity and lifecycle +
 * core/Host-API.md §session.openChild +
 * /home/ubuntu/.claude/plans/ultrathink-we-have-a-magical-gem.md §Phase E.
 */

import { join } from "node:path";

import { createSessionScope, type Scope } from "../../core/concurrency/scope.js";
import { Session } from "../../core/errors/index.js";
import { mergeSettings } from "../../core/settings/merge.js";
import {
  createSessionSubagentRegistry,
  type SessionSubagentRegistry,
} from "../../core/subagent/registry.js";
import {
  DELEGATE_DEFAULT_CONFIG,
  type DelegateConfig,
} from "../../extensions/tools/delegate/config.schema.js";
import {
  getConfig as getDelegateConfig,
  init as initDelegate,
} from "../../extensions/tools/delegate/lifecycle.js";
import { registerSubagentsPanel } from "../../extensions/ui/default-tui/panels/subagents-panel.js";

import { createIpAuthority, type IpAuthority } from "./ip-authority.js";
import { buildEventsAPI } from "./provider-host.js";
import {
  createRuntimeContextRegistry,
  type RuntimeContextRegistry,
} from "./runtime-context-registry.js";
import { loadSettingsFile, studHome } from "./storage.js";
import { buildChildRunner } from "./subagent-child-runner.js";
import { buildOpenChildClosure, buildPermissiveProviderModelLookup } from "./subagent-spawn.js";
import {
  PROTOCOLS,
  type LoadedTool,
  type ProviderProtocolId,
  type ResolvedShellDeps,
  type SessionBootstrap,
  type Settings,
} from "./types.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { ProviderContract } from "../../contracts/providers.js";
import type { EventBus } from "../../core/events/bus.js";
import type { OpenChildArgs, OpenChildResult } from "../../core/host/api/session.js";
import type { HostAPI } from "../../core/host/host-api.js";
import type { RuntimeCollector } from "../../core/host/internal/runtime-collector.js";
import type { ProviderModelLookup } from "../../core/subagent/spawn.js";
import type { MountedTUI } from "../../extensions/ui/default-tui/mount.js";
import type { UIRegionRegistry } from "../../extensions/ui/default-tui/regions.js";
import type { PromptIO } from "../prompt.js";

/**
 * Per-session subagent scaffold. Built BEFORE the orchestrator's host so the
 * `openChild` placeholder can be threaded into `createProviderHost`; the
 * real closure is wired later by {@link wireChildSessionClosure} once the
 * runtime context registry has resolved the initial entry.
 */
export interface SubagentScaffold {
  readonly sessionScope: Scope;
  readonly subagentRegistry: SessionSubagentRegistry;
  readonly ipAuthority: IpAuthority;
  readonly openChildRef: { current: ((args: OpenChildArgs) => Promise<OpenChildResult>) | null };
  readonly openChild: (args: OpenChildArgs) => Promise<OpenChildResult>;
}

export function buildSubagentScaffold(eventBus: EventBus, sessionId: string): SubagentScaffold {
  const sessionScope = createSessionScope({ monotonic: () => process.hrtime.bigint() });
  const subagentRegistry = createSessionSubagentRegistry();
  // Build a single IpAuthority for the session — orchestrator AND every
  // per-entry runtime host route through this queue so subagent IP
  // requests serialize via the comparator (D4a / Phase C).
  const sharedEventsApi = buildEventsAPI(eventBus, sessionId);
  const ipAuthority = createIpAuthority({ events: sharedEventsApi });

  const openChildRef: { current: ((args: OpenChildArgs) => Promise<OpenChildResult>) | null } = {
    current: null,
  };
  const openChild = (args: OpenChildArgs): Promise<OpenChildResult> => {
    if (openChildRef.current === null) {
      throw new Session("openChild called before runtime wiring completed", undefined, {
        code: "InvariantViolation",
      });
    }
    return openChildRef.current(args);
  };
  return { sessionScope, subagentRegistry, ipAuthority, openChildRef, openChild };
}

export interface ChildClosureWiringInput {
  readonly session: SessionBootstrap;
  readonly deps: ResolvedShellDeps;
  readonly prompt: PromptIO;
  readonly host: HostAPI;
  readonly provider: ProviderContract<unknown>;
  readonly loadedTools: readonly LoadedTool[];
  readonly auditBus: SessionAuditBus;
  readonly collector: RuntimeCollector;
  readonly ui: MountedTUI;
  readonly scaffold: SubagentScaffold;
  /**
   * Provider/model lookup for envelope-time validation. Defaults to the
   * permissive lookup that only accepts the parent provider; the runtime
   * passes a strict lookup against loaded `settings.json` providers when
   * available.
   */
  readonly providerModelLookup?: ProviderModelLookup;
  /**
   * Loaded merged settings. When supplied, the default lookup is built
   * against the `providers` map. v1: cross-provider model override is
   * REJECTED at preflight (the lookup is restricted to the parent's
   * providerId). Same-provider modelId override is accepted.
   */
  readonly loadedSettings?: Settings;
}

/**
 * Build a ProviderModelLookup from loaded merged settings. Wiki:
 * reference-extensions/tools/Delegate-Tool.md §Validation order step 2 —
 * (providerId, modelId) must be configured in `settings.json.providers`.
 *
 * v1 limitation: cross-provider model override is REJECTED at preflight
 * because the child runner reuses the parent's RuntimeContext (same
 * provider contract + host). Allowing a different `providerId` would
 * validate at preflight but then run on the parent provider, silently
 * ignoring the override. The lookup mirrors that constraint by accepting
 * only the parent's providerId. Wiki: same-provider override is in scope
 * for v1; cross-provider override is documented as a follow-up.
 */
export function buildSettingsBackedLookup(
  settings: Settings,
  parentModel: () => { readonly providerId: string; readonly modelId: string },
): ProviderModelLookup {
  return {
    hasProvider(providerId) {
      // Restrict to parent provider only for v1. See doc-block above.
      return providerId === parentModel().providerId;
    },
    hasModel(providerId, modelId) {
      if (providerId !== parentModel().providerId) return false;
      const providers = (settings.providers ?? {}) as Readonly<
        Record<string, Readonly<Record<string, unknown>>>
      >;
      const entry = providers[providerId];
      const models =
        entry === undefined ? undefined : (entry["models"] as readonly string[] | undefined);
      // If the provider entry isn't configured in settings (e.g., a test
      // harness or a session bootstrapped with defaults), accept any
      // non-empty modelId so the parent's actual model continues to validate.
      if (!Array.isArray(models)) return typeof modelId === "string" && modelId.length > 0;
      return models.includes(modelId);
    },
    satisfiesRequiredCapabilities(providerId, modelId, envelopeSize) {
      // Wiki: contracts/Capability-Negotiation.md §Required capabilities.
      // When the envelope is non-empty, the resolved provider's protocol
      // contract must declare `toolCalling: "hard"`. We resolve the
      // protocol from `settings.providers.<id>.protocol`, look up the
      // PROTOCOLS table for the declared capability, and reject when the
      // provider can't actually call tools.
      void modelId;
      if (envelopeSize === 0) return true;
      const providers = (settings.providers ?? {}) as Readonly<
        Record<string, Readonly<Record<string, unknown>>>
      >;
      const entry = providers[providerId];
      // Without a settings entry we can't determine the protocol; fall
      // back to "match parent" so the parent's actual provider validates
      // (the parent already runs tools successfully if we got this far).
      if (entry === undefined) return providerId === parentModel().providerId;
      const protocolField = entry["protocol"];
      if (typeof protocolField !== "string") return true;
      const descriptor = PROTOCOLS[protocolField as ProviderProtocolId];
      const caps = descriptor?.contract?.capabilities as unknown as
        | Readonly<Record<string, unknown>>
        | undefined;
      const toolCalling = caps?.["toolCalling"];
      if (toolCalling === undefined) return true;
      return toolCalling === "hard";
    },
  };
}

/**
 * Build an openChild closure for a session at the given `parentDepth`. Used
 * by both the orchestrator (depth=0) and each child session (depth=record.depth).
 * The childRunner is shared across depths because it's stateless across
 * spawns — what changes is `parentDepth` and the tool-trust gating.
 * Wiki: core/Subagent-Sessions.md §Identity and lifecycle (depth cap).
 */
export function buildOpenChildForDepth(
  input: ChildClosureWiringInput,
  parentDepth: number,
): (args: OpenChildArgs) => Promise<OpenChildResult> {
  const { session, scaffold } = input;
  // Pass a depth-aware factory back to the runner so each child it spawns
  // gets its own openChild with the correct parentDepth. Recursive: the
  // factory references buildOpenChildForDepth itself.
  const lookup =
    input.providerModelLookup ??
    (input.loadedSettings !== undefined
      ? buildSettingsBackedLookup(input.loadedSettings, () => {
          const sel = session.selection.current();
          return { providerId: sel.entryId, modelId: sel.modelId };
        })
      : buildPermissiveProviderModelLookup(() => {
          const sel = session.selection.current();
          return { providerId: sel.entryId, modelId: sel.modelId };
        }));
  // Read the delegate config — populated by `initDelegate` during
  // `wireChildSessionAndPanel` from layered settings (`tools.delegate`).
  // Wiki: reference-extensions/tools/Delegate-Tool.md §Config.
  const delegateConfig = getDelegateConfig();
  const childRunner = buildChildRunner({
    parentSession: session,
    parentHost: input.host,
    parentProvider: input.provider,
    parentLoadedTools: input.loadedTools,
    parentAuditBus: input.auditBus,
    parentCollector: input.collector,
    parentDeps: input.deps,
    parentPrompt: input.prompt,
    parentUi: input.ui,
    buildChildOpenChild: (childParentDepth) => buildOpenChildForDepth(input, childParentDepth),
    providerModelLookup: lookup,
    maxDepth: delegateConfig.maxDepth,
    ipAuthority: scaffold.ipAuthority,
  });
  return buildOpenChildClosure({
    parentSessionId: session.sessionId,
    parentDepth,
    maxDepth: delegateConfig.maxDepth,
    currentParentModel: () => {
      const sel = session.selection.current();
      return { providerId: sel.entryId, modelId: sel.modelId };
    },
    currentToolNames: () => input.loadedTools.map((tool) => tool.name),
    registry: scaffold.subagentRegistry,
    providerModelLookup: lookup,
    ipAuthority: scaffold.ipAuthority,
    auditBus: input.auditBus,
    parentSessionScope: scaffold.sessionScope,
    childRunner,
    // Tool-trust auto-approve is gated on the LAUNCH `--yolo` flag only,
    // not on `securityMode === "yolo"`. The wiki requires explicit opt-in
    // at launch; setting mode via config does not authorize auto-approve.
    isYolo: () => session.yolo,
  });
}

/**
 * Once the orchestrator's runtime is fully composed (host + tools + UI +
 * active selection), wire the actual `openChild` closure into the scaffold
 * for the orchestrator (parentDepth=0).
 */
export function wireChildSessionClosure(input: ChildClosureWiringInput): void {
  input.scaffold.openChildRef.current = buildOpenChildForDepth(input, 0);
}

export interface WireChildSessionAndPanelResult {
  /** Resolved provider/model lookup — propagate into tool-resolver path. */
  readonly providerModelLookup: ProviderModelLookup;
  /** Resolved `delegate.maxDepth` from layered settings (or default). */
  readonly maxDepth: number;
}

/**
 * Convenience composer: register the bundled regions, load merged settings
 * for the strict provider lookup, initialize the delegate config, and wire
 * the openChild closure. Keeps `bootstrapSessionContext` under the
 * per-function line limit. Returns the resolved lookup + maxDepth so the
 * orchestrator's tool-resolver path uses the same values delegate's
 * preflight will see.
 */
export async function wireChildSessionAndPanel(input: {
  readonly session: SessionBootstrap;
  readonly deps: ResolvedShellDeps;
  readonly prompt: PromptIO;
  readonly host: HostAPI;
  readonly provider: ProviderContract<unknown>;
  readonly loadedTools: readonly LoadedTool[];
  readonly auditBus: SessionAuditBus;
  readonly collector: RuntimeCollector;
  readonly ui: MountedTUI;
  readonly eventBus: EventBus;
  readonly scaffold: SubagentScaffold;
  readonly registerPanel: () => void;
}): Promise<WireChildSessionAndPanelResult> {
  input.registerPanel();
  const loadedSettings = await loadMergedProviderSettings(input.session, input.deps).catch(
    () => undefined,
  );
  // Initialize the bundled delegate config from layered settings.json.
  // Without this, getDelegateConfig() would return defaults forever and
  // settings.tools.delegate.maxDepth/timeoutMs/enabled would be ignored.
  await initDelegate(input.host, readDelegateSettingsConfig(loadedSettings));
  wireChildSessionClosure({
    session: input.session,
    deps: input.deps,
    prompt: input.prompt,
    host: input.host,
    provider: input.provider,
    loadedTools: input.loadedTools,
    auditBus: input.auditBus,
    collector: input.collector,
    ui: input.ui,
    scaffold: input.scaffold,
    ...(loadedSettings !== undefined ? { loadedSettings } : {}),
  });
  const providerModelLookup =
    loadedSettings !== undefined
      ? buildSettingsBackedLookup(loadedSettings, () => {
          const sel = input.session.selection.current();
          return { providerId: sel.entryId, modelId: sel.modelId };
        })
      : buildPermissiveProviderModelLookup(() => {
          const sel = input.session.selection.current();
          return { providerId: sel.entryId, modelId: sel.modelId };
        });
  return { providerModelLookup, maxDepth: getDelegateConfig().maxDepth };
}

/**
 * Resolve `settings.tools.delegate` (cast through the unstructured
 * settings shape since the bundled tool's config is not part of core's
 * Settings type). Returns the bundled defaults when no override exists.
 */
function readDelegateSettingsConfig(settings: Settings | undefined): DelegateConfig {
  if (settings === undefined) return DELEGATE_DEFAULT_CONFIG;
  const tools = (settings as { tools?: Readonly<Record<string, unknown>> }).tools;
  const entry = tools?.["delegate"];
  if (entry === undefined || typeof entry !== "object" || entry === null) {
    return DELEGATE_DEFAULT_CONFIG;
  }
  const cfg = entry as { enabled?: unknown; timeoutMs?: unknown; maxDepth?: unknown };
  return {
    ...(typeof cfg.enabled === "boolean" ? { enabled: cfg.enabled } : {}),
    ...(typeof cfg.timeoutMs === "number" ? { timeoutMs: cfg.timeoutMs } : {}),
    ...(typeof cfg.maxDepth === "number" ? { maxDepth: cfg.maxDepth } : {}),
  };
}

/**
 * Re-load layered settings.json (global ← project) for delegate-tool
 * config (`tools.delegate.maxDepth`) and provider entry resolution
 * (capability check via PROTOCOLS). v1 only honors same-provider model
 * override, so the loaded providers map is read for capability
 * declarations rather than for cross-provider routing. Uses the canonical
 * `mergeSettings` so nested maps like `providers` and `tools` are merged
 * per-key rather than via shallow spread (which would let a project
 * `tools.<other>` wipe global `tools.delegate`). Best-effort: failures
 * fall back to the permissive lookup.
 */
export async function loadMergedProviderSettings(
  session: SessionBootstrap,
  deps: ResolvedShellDeps,
): Promise<Settings | undefined> {
  const globalRoot = studHome(deps.homedir());
  const globalSettings = await loadSettingsFile(join(globalRoot, "settings.json"));
  const projectSettings = session.projectTrusted
    ? await loadSettingsFile(join(session.projectRoot, "settings.json"))
    : undefined;
  return mergeSettings(undefined, globalSettings, projectSettings) as Settings;
}

/**
 * Register the bundled Subagents panel as a region contribution. Wraps the
 * MountedTUI's registerRegion in a UIRegionRegistry-shaped adapter so the
 * panel registers via the standard region API. Wiki:
 * reference-extensions/ui/Default-TUI.md §Subagents panel.
 */
export function registerBundledSubagentsPanel(
  ui: MountedTUI,
  eventBus: EventBus,
  auditBus: SessionAuditBus,
): void {
  if (ui.registerRegion === undefined) return;
  const registerable: UIRegionRegistry = {
    register: (contribution) => ui.registerRegion?.(contribution),
    contributions: () => [],
    compose: () => null,
  };
  registerSubagentsPanel(registerable, {
    bus: eventBus,
    activeSubagents: () => auditBus.activeSubagents(),
  });
}

/**
 * Build the per-entry runtime registry and ensure the active selection's
 * runtime context is allocated. Extracted from session-loop bootstrap to
 * keep the bootstrap function under the per-function line limit.
 */
export async function ensureInitialRuntime(input: {
  readonly session: SessionBootstrap;
  readonly deps: ResolvedShellDeps;
  readonly loadedTools: readonly LoadedTool[];
  readonly getAuditBus: () => SessionAuditBus | null;
  readonly collector: RuntimeCollector;
  readonly eventBus: EventBus;
  readonly scaffold: SubagentScaffold;
  readonly initialSelection: ReturnType<SessionBootstrap["selection"]["current"]>;
}): Promise<RuntimeContextRegistry> {
  const registry = createRuntimeContextRegistry({
    session: input.session,
    deps: input.deps,
    loadedTools: input.loadedTools,
    getAuditBus: input.getAuditBus,
    collector: input.collector,
    eventBus: input.eventBus,
    ipAuthority: input.scaffold.ipAuthority,
    openChild: input.scaffold.openChild,
  });
  await registry.ensure({
    entryId: input.initialSelection.entryId,
    protocolId: input.initialSelection.protocolId,
    config: input.initialSelection.config,
  });
  return registry;
}

/**
 * Install a SIGINT (Ctrl+C) handler. Two-press model:
 *
 *   1. First press cancels the session scope — cascades through every
 *      running turn / child session / tool — and unmounts the UI so the
 *      session-loop's `waitForInput()` rejects, the main loop unwinds,
 *      and the `finally` in `runProviderSession` runs teardown. The
 *      process exits naturally once teardown finishes.
 *   2. Second press (e.g. teardown is hung on a slow audit close or
 *      provider stream that won't honor the abort) calls `process.exit`
 *      so the user is never trapped.
 *
 * Returns the handler so the runtime can `process.off` it on teardown.
 *
 * Without this, Ink's `exitOnCtrlC: false` (set so we own the signal)
 * combined with `waitForInput()` not observing the scope's signal meant
 * Ctrl+C cancelled the abstract scope but left the input loop awaiting
 * an Enter key forever — i.e. the process appeared frozen.
 */
export function installSigintCascade(
  sessionScope: Scope,
  ui: { unmount: () => Promise<void> },
): () => void {
  const handler = (): void => {
    if (sessionScope.signal.aborted) {
      // Second Ctrl+C: cleanup is hung, hard-exit. 130 = 128 + SIGINT(2).
      process.exit(130);
    }
    sessionScope.cancel("user");
    void ui.unmount().catch(() => {
      // Ignore — best-effort during shutdown.
    });
  };
  process.on("SIGINT", handler);
  return handler;
}
