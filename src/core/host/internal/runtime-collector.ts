/**
 * RuntimeCollector — internal writer that backs `host.metrics`.
 *
 * Each runtime source (provider stream, tool registry, MCP client, SM lifecycle,
 * diagnostics ring buffer, extension lifecycle) calls a typed setter on the
 * collector. The collector publishes a deeply-frozen `RuntimeSnapshot` to
 * subscribers (debounced) and exposes a `RuntimeReader` view to extensions.
 *
 * Only a `RuntimeReader` leaves the collector — the writer methods stay
 * internal so extensions cannot fabricate metrics.
 *
 * Wiki: core/Host-API.md § metrics — RuntimeReader (privacy + performance).
 */

import {
  emptyRuntimeSnapshot,
  type DiagnosticItem,
  type ExtensionInfo,
  type HookInfo,
  type McpServerInfo,
  type ProviderInfo,
  type RuntimeReader,
  type RuntimeSnapshot,
  type ToolInfo,
  type UiInfo,
} from "../api/metrics.js";

import type { SecurityMode } from "../../../contracts/settings-shape.js";

const DEFAULT_DEBOUNCE_MS = 60;
const DEFAULT_DIAGNOSTIC_BUFFER = 50;

type SnapshotListener = (snap: RuntimeSnapshot) => void;
type TokenListener = (tokens: RuntimeSnapshot["tokens"]) => void;

interface CollectorOptions {
  readonly debounceMs?: number;
  readonly diagnosticBufferSize?: number;
  readonly now?: () => number;
}

export interface RuntimeCollector {
  /** Public read view used by `host.metrics`. */
  readonly reader: RuntimeReader;

  // ---------------------------------------------------------------------------
  // Writers — internal. Each surface owns a slice and updates it idempotently.
  // ---------------------------------------------------------------------------

  setSession(update: Partial<RuntimeSnapshot["session"]>): void;
  setProvider(current: ProviderInfo, available: readonly ProviderInfo[]): void;
  addTokens(deltaInput: number, deltaOutput: number): void;
  beginTurn(): void;
  endTurn(): void;
  setContext(update: Partial<RuntimeSnapshot["context"]>): void;
  setTools(items: readonly ToolInfo[]): void;
  setMcp(servers: readonly McpServerInfo[], configuredCount: number): void;
  setStateMachine(value: RuntimeSnapshot["stateMachine"]): void;
  pushDiagnostic(item: DiagnosticItem): void;
  setUi(items: readonly UiInfo[]): void;
  setHooks(items: readonly HookInfo[]): void;
  setExtensions(items: readonly ExtensionInfo[]): void;

  /** Stop the debounce timer and clear listeners. Called on session shutdown. */
  dispose(): void;
}

interface MutableState {
  session: {
    id: string;
    startedAt: number;
    lastTurnAt?: number;
    turnCount: number;
    cwd: string;
    projectTrust: "granted" | "global-only";
    mode: SecurityMode;
    online: boolean;
  };
  provider: { current: ProviderInfo; available: readonly ProviderInfo[] };
  tokens: {
    inputTotal: number;
    outputTotal: number;
    lastTurnInput: number;
    lastTurnOutput: number;
  };
  context: {
    usedTokens: number;
    windowTokens?: number;
    percent?: number;
    assembledFragments: number;
  };
  tools: { items: readonly ToolInfo[]; activeCount: number; totalCount: number };
  mcp: {
    servers: readonly McpServerInfo[];
    connectedCount: number;
    configuredCount: number;
  };
  stateMachine?: RuntimeSnapshot["stateMachine"];
  diagnostics: { errorCount: number; warningCount: number; recent: DiagnosticItem[] };
  ui: { items: readonly UiInfo[] };
  hooks: { items: readonly HookInfo[] };
  extensions: { loaded: readonly ExtensionInfo[] };
}

function freezeSnapshot(state: MutableState): RuntimeSnapshot {
  return Object.freeze({
    session: Object.freeze({ ...state.session }),
    provider: Object.freeze({
      current: state.provider.current,
      available: Object.freeze([...state.provider.available]),
    }),
    tokens: Object.freeze({ ...state.tokens }),
    context: Object.freeze({ ...state.context }),
    tools: Object.freeze({
      items: Object.freeze([...state.tools.items]),
      activeCount: state.tools.activeCount,
      totalCount: state.tools.totalCount,
    }),
    mcp: Object.freeze({
      servers: Object.freeze([...state.mcp.servers]),
      connectedCount: state.mcp.connectedCount,
      configuredCount: state.mcp.configuredCount,
    }),
    ...(state.stateMachine !== undefined ? { stateMachine: state.stateMachine } : {}),
    diagnostics: Object.freeze({
      errorCount: state.diagnostics.errorCount,
      warningCount: state.diagnostics.warningCount,
      recent: Object.freeze([...state.diagnostics.recent]),
    }),
    ui: Object.freeze({ items: Object.freeze([...state.ui.items]) }),
    hooks: Object.freeze({ items: Object.freeze([...state.hooks.items]) }),
    extensions: Object.freeze({
      loaded: Object.freeze([...state.extensions.loaded]),
    }),
  }) as RuntimeSnapshot;
}

function initialState(now: number): MutableState {
  const empty = emptyRuntimeSnapshot(now);
  return {
    session: { ...empty.session },
    provider: {
      current: empty.provider.current,
      available: empty.provider.available,
    },
    tokens: { ...empty.tokens },
    context: { ...empty.context },
    tools: { ...empty.tools, items: empty.tools.items },
    mcp: { ...empty.mcp, servers: empty.mcp.servers },
    diagnostics: {
      errorCount: empty.diagnostics.errorCount,
      warningCount: empty.diagnostics.warningCount,
      recent: [...empty.diagnostics.recent],
    },
    ui: { items: empty.ui.items },
    hooks: { items: empty.hooks.items },
    extensions: { loaded: empty.extensions.loaded },
  };
}

/**
 * Snapshot publisher: owns the debounce timer, listener sets, and the
 * `dispose` flag. Returns the trio that the writers and reader call into.
 */
function createSnapshotPublisher(args: {
  readonly state: MutableState;
  readonly debounceMs: number;
}): {
  readonly scheduleSnapshot: () => void;
  readonly emitTokens: () => void;
  readonly snapshotListeners: Set<SnapshotListener>;
  readonly tokenListeners: Set<TokenListener>;
  readonly getSnapshot: () => RuntimeSnapshot;
  readonly markClean: () => void;
  readonly isDirty: () => boolean;
  readonly dispose: () => void;
  readonly isDisposed: () => boolean;
} {
  let snapshot = freezeSnapshot(args.state);
  let snapshotDirty = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const snapshotListeners = new Set<SnapshotListener>();
  const tokenListeners = new Set<TokenListener>();

  const refreshSnapshot = (): void => {
    if (snapshotDirty) {
      snapshot = freezeSnapshot(args.state);
      snapshotDirty = false;
    }
  };

  const publish = (): void => {
    if (disposed) return;
    refreshSnapshot();
    snapshotListeners.forEach((listener) => listener(snapshot));
  };

  const scheduleSnapshot = (): void => {
    if (disposed) return;
    snapshotDirty = true;
    if (pendingTimer !== null) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      publish();
    }, args.debounceMs);
    if (typeof pendingTimer === "object" && pendingTimer !== null && "unref" in pendingTimer) {
      (pendingTimer as { unref: () => void }).unref();
    }
  };

  const emitTokens = (): void => {
    const frozen = Object.freeze({ ...args.state.tokens });
    tokenListeners.forEach((listener) => listener(frozen));
  };

  return {
    scheduleSnapshot,
    emitTokens,
    snapshotListeners,
    tokenListeners,
    getSnapshot(): RuntimeSnapshot {
      refreshSnapshot();
      return snapshot;
    },
    markClean(): void {
      snapshotDirty = false;
    },
    isDirty(): boolean {
      return snapshotDirty;
    },
    dispose(): void {
      disposed = true;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      snapshotListeners.clear();
      tokenListeners.clear();
    },
    isDisposed(): boolean {
      return disposed;
    },
  };
}

function createReader(publisher: ReturnType<typeof createSnapshotPublisher>): RuntimeReader {
  return {
    snapshot() {
      return publisher.getSnapshot();
    },
    subscribe(handler) {
      publisher.snapshotListeners.add(handler);
      return () => {
        publisher.snapshotListeners.delete(handler);
      };
    },
    subscribeToTokens(handler) {
      publisher.tokenListeners.add(handler);
      return () => {
        publisher.tokenListeners.delete(handler);
      };
    },
  };
}

/**
 * Build the writer half of the collector. The writers mutate `state` and
 * call into the publisher to fan out updates to subscribers.
 */
function createWriters(args: {
  readonly state: MutableState;
  readonly bufferSize: number;
  readonly now: () => number;
  readonly scheduleSnapshot: () => void;
  readonly emitTokens: () => void;
}): Omit<RuntimeCollector, "reader" | "dispose"> {
  const { state, bufferSize, now, scheduleSnapshot, emitTokens } = args;
  return {
    setSession(update) {
      Object.assign(state.session, update);
      scheduleSnapshot();
    },
    setProvider(current, available) {
      state.provider = { current, available };
      scheduleSnapshot();
    },
    addTokens(deltaInput, deltaOutput) {
      state.tokens = {
        inputTotal: state.tokens.inputTotal + deltaInput,
        outputTotal: state.tokens.outputTotal + deltaOutput,
        lastTurnInput: state.tokens.lastTurnInput + deltaInput,
        lastTurnOutput: state.tokens.lastTurnOutput + deltaOutput,
      };
      emitTokens();
      scheduleSnapshot();
    },
    beginTurn() {
      state.tokens = { ...state.tokens, lastTurnInput: 0, lastTurnOutput: 0 };
      state.session.turnCount += 1;
      state.session.lastTurnAt = now();
      scheduleSnapshot();
    },
    endTurn() {
      state.session.lastTurnAt = now();
      scheduleSnapshot();
    },
    setContext(update) {
      Object.assign(state.context, update);
      scheduleSnapshot();
    },
    setTools(items) {
      const activeCount = items.filter((t) => t.allowedNow).length;
      state.tools = { items, activeCount, totalCount: items.length };
      scheduleSnapshot();
    },
    setMcp(servers, configuredCount) {
      const connectedCount = servers.filter((s) => s.status === "connected").length;
      state.mcp = { servers, connectedCount, configuredCount };
      scheduleSnapshot();
    },
    setStateMachine(value) {
      state.stateMachine = value;
      scheduleSnapshot();
    },
    pushDiagnostic(item) {
      const recent = state.diagnostics.recent;
      recent.push(item);
      while (recent.length > bufferSize) {
        recent.shift();
      }
      state.diagnostics = {
        errorCount: state.diagnostics.errorCount + (item.level === "error" ? 1 : 0),
        warningCount: state.diagnostics.warningCount + (item.level === "warn" ? 1 : 0),
        recent,
      };
      scheduleSnapshot();
    },
    setUi(items) {
      state.ui = { items };
      scheduleSnapshot();
    },
    setHooks(items) {
      state.hooks = { items };
      scheduleSnapshot();
    },
    setExtensions(items) {
      state.extensions = { loaded: items };
      scheduleSnapshot();
    },
  };
}

export function createRuntimeCollector(options: CollectorOptions = {}): RuntimeCollector {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const bufferSize = options.diagnosticBufferSize ?? DEFAULT_DIAGNOSTIC_BUFFER;
  const now = options.now ?? ((): number => Date.now());
  const state = initialState(now());
  const publisher = createSnapshotPublisher({ state, debounceMs });
  const writers = createWriters({
    state,
    bufferSize,
    now,
    scheduleSnapshot: publisher.scheduleSnapshot,
    emitTokens: publisher.emitTokens,
  });
  return {
    reader: createReader(publisher),
    ...writers,
    dispose: publisher.dispose,
  };
}
