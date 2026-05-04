import { protocolLabel } from "./bootstrap.js";
import { runtimeCommandCatalog } from "./command-catalog.js";
import { PROTOCOLS } from "./provider-protocols.js";

import type { ProviderMessage } from "../../contracts/providers.js";
import type { EventBus } from "../../core/events/bus.js";
import type { RuntimeCollector } from "../../core/host/internal/runtime-collector.js";
import type { MountedTUI, mountTUI as MountTUI } from "../../extensions/ui/default-tui/mount.js";
import type { PromptIO } from "../prompt.js";
import type {
  disposeBundledTools as DisposeBundledTools,
  initializeBundledTools as InitializeBundledTools,
  providerToolDefinitions as ProviderToolDefinitions,
} from "./tool-registry.js";
import type {
  LoadedTool,
  ProviderProtocolId,
  ResolvedShellDeps,
  SessionBootstrap,
} from "./types.js";

interface ToolRegistryModule {
  readonly disposeBundledTools: typeof DisposeBundledTools;
  readonly initializeBundledTools: typeof InitializeBundledTools;
  readonly providerToolDefinitions: typeof ProviderToolDefinitions;
}

interface TuiModule {
  readonly mountTUI: typeof MountTUI;
}

let toolRegistryModulePromise: Promise<ToolRegistryModule> | null = null;
let tuiModulePromise: Promise<TuiModule> | null = null;

export function loadToolRegistryModule(): Promise<ToolRegistryModule> {
  toolRegistryModulePromise ??= import("./tool-registry.js") as Promise<ToolRegistryModule>;
  return toolRegistryModulePromise;
}

function loadTuiModule(): Promise<TuiModule> {
  tuiModulePromise ??= import("../../extensions/ui/default-tui/mount.js") as Promise<TuiModule>;
  return tuiModulePromise;
}

export function seedRuntimeMetrics(
  collector: RuntimeCollector,
  descriptor: (typeof PROTOCOLS)[ProviderProtocolId],
  session: SessionBootstrap,
  loadedTools: readonly LoadedTool[],
): void {
  const selection = session.selection.current();
  const levelToBoolean = (level: string): boolean => level === "hard" || level === "preferred";
  collector.setProvider(
    {
      id: selection.entryId,
      label: descriptor.label,
      modelId: selection.modelId,
      capabilities: {
        streaming: levelToBoolean(descriptor.capabilities.streaming),
        toolCalling: levelToBoolean(descriptor.capabilities.toolCalling),
        thinking: levelToBoolean(descriptor.capabilities.reasoning),
      },
    },
    Object.values(PROTOCOLS).map((provider) => ({
      id: provider.protocolId,
      label: provider.label,
      modelId: provider.defaultModels[0],
      capabilities: {
        streaming: levelToBoolean(provider.capabilities.streaming),
        toolCalling: levelToBoolean(provider.capabilities.toolCalling),
        thinking: levelToBoolean(provider.capabilities.reasoning),
      },
    })),
  );
  collector.setTools(
    loadedTools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      source: "bundled",
      sensitivity: tool.gated ? "guarded" : "safe",
      allowedNow: !tool.gated || session.yolo,
      invocations: { total: 0, succeeded: 0, failed: 0 },
    })),
  );
}

export async function mountSessionUI(args: {
  readonly deps: ResolvedShellDeps;
  readonly prompt: PromptIO;
  readonly collector: RuntimeCollector;
  readonly session: SessionBootstrap;
  readonly workspaceRoot: string;
  readonly resumedHistory: readonly ProviderMessage[];
  readonly eventBus: EventBus;
}): Promise<MountedTUI> {
  const { mountTUI } = await loadTuiModule();
  const catalog = runtimeCommandCatalog().map((entry) => ({
    name: entry.name,
    description: entry.description,
    category: entry.category,
  }));
  const ui = await mountTUI({
    stdout: args.deps.stdout,
    stdin: args.deps.stdin,
    fallbackPrompt: args.prompt,
    version: args.deps.packageVersion,
    metrics: args.collector.reader,
    catalog,
    eventBus: args.eventBus,
  });
  const selection = args.session.selection.current();
  ui.renderSessionStart({
    sessionId: args.session.sessionId,
    providerLabel: protocolLabel(selection.protocolId),
    modelId: selection.modelId,
    mode: args.session.securityMode,
    projectTrust: args.session.projectTrusted ? "granted" : "global-only",
    cwd: args.workspaceRoot,
  });
  if (args.session.resumed) {
    ui.renderHistory(args.resumedHistory);
  }
  return ui;
}
