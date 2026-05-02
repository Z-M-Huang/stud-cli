import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Session } from "../../core/errors/index.js";
import { createEventBus } from "../../core/events/bus.js";
import { mountTUI } from "../../extensions/ui/default-tui/mount.js";

import { startSessionAuditBus, type SessionAuditBus } from "./audit-bus.js";
import { protocolLabel } from "./bootstrap.js";
import { runtimeCommandCatalog } from "./command-catalog.js";
import { checkManifestSizeBudget, manifestSizeBudgetPayload } from "./manifest-size-budget.js";
import { createProviderHost } from "./provider-host.js";
import { runAssistantIteration } from "./provider-stream.js";
import {
  createRuntimeContextRegistry,
  type RuntimeContextRegistry,
} from "./runtime-context-registry.js";
import {
  emitLaunchOverrideAudit,
  emitPreHydrationSizeBudget,
  emitPriorRuntimeOverridesSurface,
} from "./session-bootstrap-emit.js";
import { handleRuntimeCommand } from "./session-commands.js";
import {
  errorToAuditPayload,
  persistHistorySnapshot,
  prepareManifestSnapshot,
  providerMessagesFromManifest,
  renderTurnError,
  toolResultMessage,
} from "./session-helpers.js";
import { persistSessionManifest } from "./session-store.js";
import { studHome } from "./storage.js";
import { createApprovalCache } from "./tool-approval.js";
import {
  disposeBundledTools,
  initializeBundledTools,
  providerToolDefinitions,
  sessionWorkspaceRoot,
} from "./tool-registry.js";
import { resolveToolCallResult } from "./tool-resolver.js";
import { PROTOCOLS, TOOL_CALL_CONTINUATION_LIMIT } from "./types.js";

import type {
  LoadedTool,
  ProviderProtocolId,
  ResolvedShellDeps,
  SessionBootstrap,
} from "./types.js";
import type {
  ProviderContract,
  ProviderMessage,
  ProviderToolDefinition,
} from "../../contracts/providers.js";
import type { SessionManifest } from "../../contracts/session-store.js";
import type { InteractionAPI } from "../../core/host/api/interaction.js";
import type { HostAPI } from "../../core/host/host-api.js";
import type { RuntimeCollector } from "../../core/host/internal/runtime-collector.js";
import type { MountedTUI } from "../../extensions/ui/default-tui/mount.js";
import type { PromptIO } from "../prompt.js";

interface ContinueAssistantTurnArgs {
  readonly session: SessionBootstrap;
  readonly provider: ProviderContract<unknown>;
  readonly host: HostAPI;
  readonly history: ProviderMessage[];
  readonly tools: readonly LoadedTool[];
  readonly toolDefinitions: readonly ProviderToolDefinition[];
  readonly approvalCache: ReturnType<typeof createApprovalCache>;
  readonly deps: ResolvedShellDeps;
  readonly prompt: PromptIO;
  readonly ui: MountedTUI;
  readonly collector: RuntimeCollector;
  readonly auditBus: SessionAuditBus;
  readonly turnId: string;
}

async function continueAssistantTurn(args: ContinueAssistantTurnArgs): Promise<void> {
  const toolMap = new Map(args.tools.map((tool) => [tool.name, tool] as const));
  const workspaceRoot = sessionWorkspaceRoot(args.session, args.deps);

  for (let iteration = 0; iteration < TOOL_CALL_CONTINUATION_LIMIT; iteration += 1) {
    const assistantTurn = await runAssistantIteration({
      session: args.session,
      provider: args.provider,
      host: args.host,
      history: args.history,
      toolDefinitions: args.toolDefinitions,
      collector: args.collector,
      auditBus: args.auditBus,
      deps: args.deps,
      iteration,
    });
    args.history.push(assistantTurn.assistantMessage);
    if (assistantTurn.finishReason !== "tool-calls" || assistantTurn.toolCalls.length === 0) {
      return;
    }
    for (const call of assistantTurn.toolCalls) {
      args.history.push(
        toolResultMessage(
          call,
          await resolveToolCallResult({
            call,
            toolMap,
            session: args.session,
            prompt: args.prompt,
            approvalCache: args.approvalCache,
            workspaceRoot,
            deps: args.deps,
            host: args.host,
            ui: args.ui,
            auditBus: args.auditBus,
          }),
        ),
      );
    }
  }

  throw new Session("assistant exceeded the tool-call continuation limit", undefined, {
    code: "ToolExecutionFailed",
    limit: TOOL_CALL_CONTINUATION_LIMIT,
  });
}

function seedRuntimeMetrics(
  collector: RuntimeCollector,
  descriptor: (typeof PROTOCOLS)[ProviderProtocolId],
  session: SessionBootstrap,
  loadedTools: readonly LoadedTool[],
): void {
  const selection = session.selection.current();
  collector.setProvider(
    {
      id: selection.entryId,
      label: descriptor.label,
      modelId: selection.modelId,
      capabilities: { streaming: true, toolCalling: true, thinking: false },
    },
    Object.values(PROTOCOLS).map((d) => ({
      id: d.protocolId,
      label: d.label,
      modelId: d.defaultModels[0],
      capabilities: { streaming: true, toolCalling: true, thinking: false },
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

function mountSessionUI(args: {
  readonly deps: ResolvedShellDeps;
  readonly prompt: PromptIO;
  readonly collector: RuntimeCollector;
  readonly session: SessionBootstrap;
  readonly workspaceRoot: string;
  readonly resumedHistory: readonly ProviderMessage[];
  readonly eventBus: ReturnType<typeof createEventBus>;
}): MountedTUI {
  const catalog = runtimeCommandCatalog().map((entry) => ({
    name: entry.name,
    description: entry.description,
    category: entry.category,
  }));
  const ui = mountTUI({
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

interface SessionContext {
  readonly session: SessionBootstrap;
  readonly deps: ResolvedShellDeps;
  readonly prompt: PromptIO;
  readonly interaction: InteractionAPI;
  readonly registry: RuntimeContextRegistry;
  readonly collector: RuntimeCollector;
  readonly loadedTools: LoadedTool[];
  readonly auditBus: SessionAuditBus;
  readonly host: HostAPI;
  readonly approvalCache: ReturnType<typeof createApprovalCache>;
  readonly history: ProviderMessage[];
  readonly ui: MountedTUI;
  manifest: SessionManifest;
}

async function bootstrapSessionContext(
  session: SessionBootstrap,
  deps: ResolvedShellDeps,
  prompt: PromptIO,
): Promise<SessionContext> {
  const initialSelection = session.selection.current();
  const loadedTools: LoadedTool[] = [];
  let auditBus: SessionAuditBus | null = null;
  const eventBus = createEventBus({ monotonic: () => process.hrtime.bigint() });
  const baseHost = createProviderHost(
    session,
    deps,
    join(studHome(deps.homedir()), "secrets.json"),
    loadedTools,
    () => auditBus,
    undefined,
    eventBus,
  );
  const collector = baseHost.collector;
  auditBus = await startSessionAuditBus({
    host: baseHost,
    sessionId: session.sessionId,
    globalRoot: studHome(deps.homedir()),
  });
  emitPreHydrationSizeBudget(session, baseHost, auditBus);
  emitPriorRuntimeOverridesSurface(session, baseHost, auditBus);
  emitLaunchOverrideAudit(session, baseHost, auditBus);

  auditBus.emit(session.resumed ? "SessionResumed" : "SessionStarted", {
    storeId: "filesystem-session-store",
    projectRoot: session.projectRoot,
    mode: session.securityMode,
    providerId: initialSelection.entryId,
    modelId: initialSelection.modelId,
  });

  const registry = createRuntimeContextRegistry({
    session,
    deps,
    loadedTools,
    getAuditBus: () => auditBus,
    collector,
    eventBus,
  });
  await registry.ensure({
    entryId: initialSelection.entryId,
    protocolId: initialSelection.protocolId,
    config: initialSelection.config,
  });

  loadedTools.push(...(await initializeBundledTools(session, deps, prompt)));
  const initialDescriptor = PROTOCOLS[initialSelection.protocolId];
  seedRuntimeMetrics(collector, initialDescriptor, session, loadedTools);
  const manifest = await persistSessionManifest(session.manifest, deps);
  const history = providerMessagesFromManifest(manifest);
  const approvalCache = createApprovalCache(loadedTools);
  const workspaceRoot = sessionWorkspaceRoot(session, deps);
  const ui = mountSessionUI({
    deps,
    prompt,
    collector,
    session,
    workspaceRoot,
    resumedHistory: history,
    eventBus,
  });

  // Re-seed metrics whenever the active selection changes so the TUI header
  // and metrics dashboard reflect the new entry/model immediately.
  session.selection.onChange(() => {
    seedRuntimeMetrics(
      collector,
      PROTOCOLS[session.selection.current().protocolId],
      session,
      loadedTools,
    );
  });

  return {
    session,
    deps,
    prompt,
    interaction: baseHost.interaction,
    registry,
    collector,
    loadedTools,
    auditBus,
    host: baseHost,
    approvalCache,
    history,
    ui,
    manifest,
  };
}

async function runOneTurn(ctx: SessionContext, trimmed: string): Promise<void> {
  const { ui, history, collector, deps, session, auditBus } = ctx;
  // The UI echoes the user's message at submit time (so a message typed
  // mid-turn appears immediately rather than only when the loop picks it
  // up). The session-loop owns history persistence, not the echo. `ui` is
  // still used below to render turn errors.
  history.push({ role: "user", content: trimmed });
  collector.beginTurn();
  const turnId = `turn-${randomUUID()}`;
  const turnStartedAt = deps.now().getTime();
  const turnAuditBus = auditBus;
  await turnAuditBus.withTurn(turnId, async () => {
    turnAuditBus.emit("TurnStarted", {
      turnId,
      userInput: trimmed,
      historyLength: history.length,
    });
    try {
      const currentEntry = ctx.session.selection.current();
      const runtime = ctx.registry.get(currentEntry.entryId);
      await continueAssistantTurn({
        session,
        provider: runtime.contract,
        host: runtime.host,
        history,
        tools: ctx.loadedTools,
        toolDefinitions: providerToolDefinitions(ctx.loadedTools),
        approvalCache: ctx.approvalCache,
        deps,
        prompt: ctx.prompt,
        ui,
        collector,
        auditBus: turnAuditBus,
        turnId,
      });
      // Pre-save manifest-size budget check per `wiki/core/Session-Manifest.md:59`.
      // Build the next manifest snapshot, check its size BEFORE writing to
      // disk so the budget event fires before persistence — including in the
      // case where the oversized write itself would fail. Emission is
      // informational; persistence proceeds regardless.
      const prepared = prepareManifestSnapshot({ manifest: ctx.manifest, history });
      const sizeCheck = checkManifestSizeBudget(prepared);
      if (sizeCheck.exceeded) {
        const payload = manifestSizeBudgetPayload("pre-save", sizeCheck);
        ctx.host.events.emit("ManifestSizeBudgetExceeded", payload);
        turnAuditBus.emit("ManifestSizeBudgetExceeded", { ...payload });
      }
      ctx.manifest = await persistHistorySnapshot({ manifest: ctx.manifest, history, deps });
      turnAuditBus.emit("SessionPersisted", {
        storeId: "filesystem-session-store",
        messageCount: history.length,
      });
      turnAuditBus.emit("TurnEnded", {
        turnId,
        durationMs: deps.now().getTime() - turnStartedAt,
        historyLength: history.length,
      });
      collector.setSession({ online: true });
    } catch (error) {
      ui.renderTurnError(renderTurnError(session, error));
      collector.setSession({ online: false });
      turnAuditBus.emit("TurnError", {
        turnId,
        durationMs: deps.now().getTime() - turnStartedAt,
        ...errorToAuditPayload(error),
      });
      collector.pushDiagnostic({
        at: deps.now().getTime(),
        level: "error",
        source: "session-loop",
        code: "TurnFailed",
        message: renderTurnError(session, error),
      });
    } finally {
      collector.endTurn();
    }
  });
}

async function processInputLine(
  ctx: SessionContext,
  trimmed: string,
): Promise<"continue" | "exit"> {
  if (trimmed.length === 0) {
    return "continue";
  }
  if (trimmed === "/exit" || trimmed === "/quit") {
    return "exit";
  }
  const command = await handleRuntimeCommand({
    line: trimmed,
    session: ctx.session,
    tools: ctx.loadedTools,
    manifest: ctx.manifest,
    history: ctx.history,
    deps: ctx.deps,
    interaction: ctx.interaction,
    registry: ctx.registry,
    auditBus: ctx.auditBus,
    host: ctx.host,
    notify: (text) => ctx.ui.renderNotice(text),
    metrics: ctx.collector.reader,
    persist: (currentManifest, currentHistory) =>
      persistHistorySnapshot({
        manifest: currentManifest,
        history: currentHistory,
        deps: ctx.deps,
      }),
  });
  if (command === "exit") return "exit";
  if (command === "handled") return "continue";
  await runOneTurn(ctx, trimmed);
  return "continue";
}

async function teardownSession(ctx: SessionContext): Promise<void> {
  await ctx.ui.unmount();
  ctx.auditBus.emit("SessionClosed", { storeId: "filesystem-session-store" });
  await disposeBundledTools();
  await ctx.registry.disposeAll();
  await ctx.auditBus.close();
}

export async function runProviderSession(
  session: SessionBootstrap,
  deps: ResolvedShellDeps,
  prompt: PromptIO,
): Promise<void> {
  const ctx = await bootstrapSessionContext(session, deps, prompt);
  try {
    while (true) {
      const trimmed = (await ctx.ui.waitForInput()).trim();
      const decision = await processInputLine(ctx, trimmed);
      if (decision === "exit") {
        break;
      }
    }
  } finally {
    await teardownSession(ctx);
  }
}
