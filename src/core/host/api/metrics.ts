/**
 * RuntimeReader — public read-only projection of runtime state.
 *
 * Extensions use this surface to render dashboards, status-line widgets,
 * sidebars, alternate UIs, and diagnostics views. It is **projection only**:
 * snapshotting or subscribing carries no authority and cannot mutate session
 * behavior.
 *
 * Privacy guarantees (load-bearing):
 *   - No environment values, secrets, or credential references are ever
 *     surfaced through `RuntimeSnapshot`. Invariant #2 (LLM context isolation)
 *     still holds.
 *   - No `settings.json` content is exposed; per-extension config lives in
 *     `config.readOwn()`.
 *   - `DiagnosticItem.message` is the human-safe message form; the audit path
 *     keeps the full chain.
 *   - Snapshots are deeply readonly.
 *
 * Wiki: core/Host-API.md § metrics — RuntimeReader
 */

import type { CategoryKind } from "../../../contracts/meta.js";
import type { SecurityMode } from "../../../contracts/settings-shape.js";

/** Alias for compatibility with Host-API.md naming ("ExtensionKind"). */
export type ExtensionKind = CategoryKind;

// ---------------------------------------------------------------------------
// Per-slice item shapes
// ---------------------------------------------------------------------------

export interface ProviderInfo {
  readonly id: string;
  readonly label: string;
  readonly modelId: string;
  readonly capabilities: {
    readonly streaming: boolean;
    readonly toolCalling: boolean;
    readonly thinking: boolean;
    readonly contextWindow?: number;
  };
}

export interface ToolInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Layer the tool was loaded from. */
  readonly source: "bundled" | "global" | "project" | "mcp";
  /** Tools tagged `guarded` always require approval; `safe` may pass under SM/mode. */
  readonly sensitivity: "safe" | "guarded";
  /** Resolved against the current SM `allowedTools`, security mode, and allowlist. */
  readonly allowedNow: boolean;
  /** Per-tool approval-key shape, when the tool exposes one. */
  readonly approvalKey?: string;
  readonly invocations: {
    readonly total: number;
    readonly succeeded: number;
    readonly failed: number;
  };
}

export interface McpServerInfo {
  readonly id: string;
  /** Transport identifier — typically `"stdio"`, `"http"`, or `"sse"`. */
  readonly transport: string;
  readonly status: "connected" | "connecting" | "disconnected" | "error";
  readonly promptCount: number;
  readonly resourceCount: number;
  readonly toolCount: number;
  readonly lastError?: string;
}

export interface UiInfo {
  readonly id: string;
  /** Subscriber / interactor / region. */
  readonly roles: readonly ("subscriber" | "interactor" | "region")[];
  /** For region contributors, the UI id whose renderer-local ABI they target. */
  readonly targetUI?: string;
  readonly regionContributions?: readonly {
    readonly region: string;
    readonly mode: "replace" | "append" | "decorate";
    readonly priority: number;
    readonly id: string;
  }[];
  readonly active: boolean;
}

export interface DiagnosticItem {
  readonly at: number;
  readonly level: "info" | "warn" | "error";
  /** Source extension id, or `"core"`. */
  readonly source: string;
  readonly code?: string;
  /** Human-safe message; never raw secrets or stack traces. */
  readonly message: string;
}

export interface ExtensionInfo {
  readonly id: string;
  readonly kind: ExtensionKind;
  readonly contractVersion: string;
  readonly source: "bundled" | "global" | "project";
  readonly active: boolean;
  readonly validationSeverity?: "critical" | "optional";
}

export interface HookInfo {
  readonly id: string;
  readonly stage: string;
  readonly point: "pre" | "post";
  readonly kind: "transform" | "guard" | "observer";
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface RuntimeSnapshot {
  readonly session: {
    readonly id: string;
    readonly startedAt: number;
    readonly lastTurnAt?: number;
    readonly turnCount: number;
    readonly cwd: string;
    readonly projectTrust: "granted" | "global-only";
    readonly mode: SecurityMode;
    readonly online: boolean;
  };

  readonly provider: {
    readonly current: ProviderInfo;
    readonly available: readonly ProviderInfo[];
  };

  readonly tokens: {
    readonly inputTotal: number;
    readonly outputTotal: number;
    readonly lastTurnInput: number;
    readonly lastTurnOutput: number;
  };

  readonly context: {
    readonly usedTokens: number;
    readonly windowTokens?: number;
    readonly percent?: number;
    readonly assembledFragments: number;
  };

  readonly tools: {
    readonly items: readonly ToolInfo[];
    readonly activeCount: number;
    readonly totalCount: number;
  };

  readonly mcp: {
    readonly servers: readonly McpServerInfo[];
    readonly connectedCount: number;
    readonly configuredCount: number;
  };

  readonly stateMachine?: {
    readonly id: string;
    readonly attached: boolean;
    readonly currentStage?: string;
    readonly stack: readonly string[];
    readonly turnCap?: number;
    readonly turnCount: number;
    readonly lastNextResult?: {
      readonly execution: "sequential" | "parallel";
      readonly stages: readonly string[];
    };
  };

  readonly diagnostics: {
    readonly errorCount: number;
    readonly warningCount: number;
    readonly recent: readonly DiagnosticItem[];
  };

  readonly ui: {
    readonly items: readonly UiInfo[];
  };

  readonly hooks: {
    readonly items: readonly HookInfo[];
  };

  readonly extensions: {
    readonly loaded: readonly ExtensionInfo[];
  };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export interface RuntimeReader {
  /** Returns the current deeply-readonly snapshot. Stable identity until state changes. */
  snapshot(): RuntimeSnapshot;

  /**
   * Subscribe to snapshot changes. The handler is called with the latest
   * snapshot; updates are debounced at the collector (default 60 ms) to avoid
   * render thrash. Returns an unsubscribe function.
   */
  subscribe(handler: (snap: RuntimeSnapshot) => void): () => void;

  /**
   * Fine-grained subscription for high-rate `tokens` updates during streaming.
   * Bypasses the snapshot debounce. Use when a widget intentionally wants
   * every delta; otherwise prefer `subscribe`.
   */
  subscribeToTokens(handler: (tokens: RuntimeSnapshot["tokens"]) => void): () => void;
}

// ---------------------------------------------------------------------------
// Default (empty) snapshot
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER: ProviderInfo = Object.freeze({
  id: "unknown",
  label: "unknown",
  modelId: "unknown",
  capabilities: Object.freeze({
    streaming: false,
    toolCalling: false,
    thinking: false,
  }),
});

/** Build an empty deeply-frozen snapshot. Used as the initial collector state. */
export function emptyRuntimeSnapshot(now: number = Date.now()): RuntimeSnapshot {
  return Object.freeze({
    session: Object.freeze({
      id: "",
      startedAt: now,
      turnCount: 0,
      cwd: "",
      projectTrust: "global-only" as const,
      mode: "ask" as SecurityMode,
      online: true,
    }),
    provider: Object.freeze({
      current: DEFAULT_PROVIDER,
      available: Object.freeze([]) as readonly ProviderInfo[],
    }),
    tokens: Object.freeze({
      inputTotal: 0,
      outputTotal: 0,
      lastTurnInput: 0,
      lastTurnOutput: 0,
    }),
    context: Object.freeze({
      usedTokens: 0,
      assembledFragments: 0,
    }),
    tools: Object.freeze({
      items: Object.freeze([]) as readonly ToolInfo[],
      activeCount: 0,
      totalCount: 0,
    }),
    mcp: Object.freeze({
      servers: Object.freeze([]) as readonly McpServerInfo[],
      connectedCount: 0,
      configuredCount: 0,
    }),
    diagnostics: Object.freeze({
      errorCount: 0,
      warningCount: 0,
      recent: Object.freeze([]) as readonly DiagnosticItem[],
    }),
    ui: Object.freeze({
      items: Object.freeze([]) as readonly UiInfo[],
    }),
    hooks: Object.freeze({
      items: Object.freeze([]) as readonly HookInfo[],
    }),
    extensions: Object.freeze({
      loaded: Object.freeze([]) as readonly ExtensionInfo[],
    }),
  });
}
