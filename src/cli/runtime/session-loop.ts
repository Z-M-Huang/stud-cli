import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Session } from "../../core/errors/index.js";
import { createEventBus } from "../../core/events/bus.js";

import { startSessionAuditBus } from "./audit-bus.js";
import { checkManifestSizeBudget, manifestSizeBudgetPayload } from "./manifest-size-budget.js";
import { createProviderHost } from "./provider-host.js";
import { PROTOCOLS } from "./provider-protocols.js";
import { runAssistantIteration } from "./provider-stream.js";
import { emitSessionStartAudits } from "./session-bootstrap-emit.js";
import { handleRuntimeCommand } from "./session-commands.js";
import {
  errorToAuditPayload,
  persistHistorySnapshot,
  prepareManifestSnapshot,
  providerMessagesFromManifest,
  renderTurnError,
  toolResultMessage,
} from "./session-helpers.js";
import {
  loadToolRegistryModule,
  mountSessionUI,
  seedRuntimeMetrics,
} from "./session-runtime-support.js";
import { persistSessionManifest } from "./session-store.js";
import { studHome } from "./storage.js";
import {
  buildSubagentScaffold,
  ensureInitialRuntime,
  installSigintCascade,
  registerBundledSubagentsPanel,
  wireChildSessionAndPanel,
} from "./subagent-bootstrap.js";
import { createApprovalCache } from "./tool-approval.js";
import { resolveToolCallResult } from "./tool-resolver.js";
import { sessionWorkspaceRoot } from "./tool-runtime-utils.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { IpAuthority } from "./ip-authority.js";
import type { RuntimeContextRegistry } from "./runtime-context-registry.js";
import type { LoadedTool, ResolvedShellDeps, SessionBootstrap } from "./types.js";
import type {
  ProviderContract,
  ProviderMessage,
  ProviderToolDefinition,
} from "../../contracts/providers.js";
import type { SessionManifest } from "../../contracts/session-store.js";
import type { Scope } from "../../core/concurrency/scope.js";
import type { InteractionAPI } from "../../core/host/api/interaction.js";
import type { HostAPI } from "../../core/host/host-api.js";
import type { RuntimeCollector } from "../../core/host/internal/runtime-collector.js";
import type { SessionSubagentRegistry } from "../../core/subagent/registry.js";
import type { ProviderModelLookup } from "../../core/subagent/spawn.js";
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
  /** Cascades from the session scope; cancels the in-flight stream + tools. */
  readonly turnSignal: AbortSignal;
  /** Settings-backed provider/model lookup propagated to tool preflight. */
  readonly providerModelLookup?: ProviderModelLookup;
  /** Resolved delegate.maxDepth propagated to tool preflight. */
  readonly maxDepth?: number;
}

async function continueAssistantTurn(args: ContinueAssistantTurnArgs): Promise<void> {
  const toolMap = new Map(args.tools.map((tool) => [tool.name, tool] as const));
  const workspaceRoot = sessionWorkspaceRoot(args.session, args.deps);

  for (let iteration = 0; iteration < args.session.continuationMaxIterations; iteration += 1) {
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
      signal: args.turnSignal,
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
            signal: args.turnSignal,
            ...(args.providerModelLookup !== undefined
              ? { providerModelLookup: args.providerModelLookup }
              : {}),
            ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
          }),
        ),
      );
    }
  }

  throw new Session(
    `assistant exhausted the continuation-round budget (${args.session.continuationMaxIterations}); earlier tool calls may have completed successfully`,
    undefined,
    {
      code: "ToolExecutionFailed",
      failureKind: "ContinuationLimitExceeded",
      limit: args.session.continuationMaxIterations,
    },
  );
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
  approvalCache: ReturnType<typeof createApprovalCache>;
  readonly history: ProviderMessage[];
  readonly ui: MountedTUI;
  readonly sessionScope: Scope;
  readonly subagentRegistry: SessionSubagentRegistry;
  readonly ipAuthority: IpAuthority;
  readonly sigintHandler: () => void;
  readonly providerModelLookup?: ProviderModelLookup;
  readonly maxDepth?: number;
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
  const scaffold = buildSubagentScaffold(eventBus, session.sessionId);

  const baseHost = createProviderHost(
    session,
    deps,
    join(studHome(deps.homedir()), "secrets.json"),
    loadedTools,
    () => auditBus,
    undefined,
    eventBus,
    scaffold.ipAuthority,
    scaffold.openChild,
  );
  const collector = baseHost.collector;
  auditBus = await startSessionAuditBus({
    host: baseHost,
    sessionId: session.sessionId,
    globalRoot: studHome(deps.homedir()),
  });
  await emitSessionStartAudits(session, baseHost, auditBus, deps);
  const registry = await ensureInitialRuntime({
    session,
    deps,
    loadedTools,
    getAuditBus: () => auditBus,
    collector,
    eventBus,
    scaffold,
    initialSelection,
  });

  seedRuntimeMetrics(collector, PROTOCOLS[initialSelection.protocolId], session, loadedTools);
  const manifest = await persistSessionManifest(session.manifest, deps);
  const history = providerMessagesFromManifest(manifest);
  const approvalCache = createApprovalCache([]);
  const workspaceRoot = sessionWorkspaceRoot(session, deps);
  const ui = await mountSessionUI({
    deps,
    prompt,
    collector,
    session,
    workspaceRoot,
    resumedHistory: history,
    eventBus,
  });

  // Subagent parent host = registry-context host (where each provider's
  // `init` ran), not baseHost. Otherwise the WeakMap-by-host config
  // lookup misses and the child throws "provider not initialized".
  const initialContext = registry.get(initialSelection.entryId);
  const wiring = await wireChildSessionAndPanel({
    session,
    deps,
    prompt,
    host: initialContext.host,
    provider: initialContext.contract,
    loadedTools,
    auditBus,
    collector,
    ui,
    eventBus,
    scaffold,
    registerPanel: () => registerBundledSubagentsPanel(ui, eventBus, auditBus),
  });
  session.selection.onChange(() =>
    seedRuntimeMetrics(
      collector,
      PROTOCOLS[session.selection.current().protocolId],
      session,
      loadedTools,
    ),
  );
  const onSigint = installSigintCascade(scaffold.sessionScope, ui);
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
    sessionScope: scaffold.sessionScope,
    subagentRegistry: scaffold.subagentRegistry,
    ipAuthority: scaffold.ipAuthority,
    providerModelLookup: wiring.providerModelLookup,
    maxDepth: wiring.maxDepth,
    manifest,
    sigintHandler: onSigint,
  };
}

async function ensureBundledToolsLoaded(ctx: SessionContext): Promise<void> {
  if (ctx.loadedTools.length > 0) {
    return;
  }
  const toolRegistry = await loadToolRegistryModule();
  ctx.loadedTools.push(
    ...(await toolRegistry.initializeBundledTools(ctx.session, ctx.deps, ctx.prompt)),
  );
  ctx.approvalCache = createApprovalCache(ctx.loadedTools);
  seedRuntimeMetrics(
    ctx.collector,
    PROTOCOLS[ctx.session.selection.current().protocolId],
    ctx.session,
    ctx.loadedTools,
  );
}

async function runOneTurn(ctx: SessionContext, trimmed: string): Promise<void> {
  const { ui, history, collector, deps, session, auditBus } = ctx;
  await ensureBundledToolsLoaded(ctx);
  history.push({ role: "user", content: trimmed });
  collector.beginTurn();
  const turnId = `turn-${randomUUID()}`;
  const turnStartedAt = deps.now().getTime();
  const turnAuditBus = auditBus;
  // Each turn runs under a child of the session scope so Ctrl+C cascades
  // through provider-stream and every active tool execution.
  const turnScope = ctx.sessionScope.child("turn");
  await turnAuditBus.withTurn(turnId, async () => {
    turnAuditBus.emit("TurnStarted", {
      turnId,
      userInput: trimmed,
      historyLength: history.length,
    });
    try {
      const currentEntry = ctx.session.selection.current();
      const runtime = ctx.registry.get(currentEntry.entryId);
      const { providerToolDefinitions } = await loadToolRegistryModule();
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
        turnSignal: turnScope.signal,
        ...(ctx.providerModelLookup !== undefined
          ? { providerModelLookup: ctx.providerModelLookup }
          : {}),
        ...(ctx.maxDepth !== undefined ? { maxDepth: ctx.maxDepth } : {}),
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
  await ensureBundledToolsLoaded(ctx);
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
  process.off("SIGINT", ctx.sigintHandler);
  await ctx.ui.unmount();
  ctx.auditBus.emit("SessionClosed", { storeId: "filesystem-session-store" });
  const { disposeBundledTools } = await loadToolRegistryModule();
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
      let trimmed: string;
      try {
        trimmed = (await ctx.ui.waitForInput()).trim();
      } catch (err) {
        // The Ctrl+C handler unmounts the UI, which rejects the queue
        // with an "ui unmounted" Error. That is a clean shutdown signal,
        // not a session-level failure — break out and let the finally
        // run teardown so the process exits with status 0.
        if (err instanceof Error && err.message === "ui unmounted") {
          break;
        }
        throw err;
      }
      const decision = await processInputLine(ctx, trimmed);
      if (decision === "exit") {
        break;
      }
    }
  } finally {
    await teardownSession(ctx);
  }
}
