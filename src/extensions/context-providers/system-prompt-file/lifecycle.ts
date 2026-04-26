import { resolve } from "node:path";

import { ExtensionHost, Validation } from "../../../core/errors/index.js";

import { readFileContent } from "./read.js";
import { checkPathTrust } from "./trust-check.js";

import type { SystemPromptFileConfig } from "./config.schema.js";
import type { ContextFragment } from "../../../contracts/context-providers.js";
import type { HostAPI } from "../../../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Module-level state — one slot per active host instance
// ---------------------------------------------------------------------------

interface ProviderState {
  readonly resolvedPath: string;
  readonly tokenBudget: number;
  /** Per-turn cached file content; invalidated on `SessionTurnEnd`. */
  cachedContent: string | null;
  /**
   * Bound event handler reference. Kept here so the same function identity
   * can be passed to both `events.on` and `events.off`.
   */
  readonly onTurnEnd: (payload: unknown) => void;
}

const statesByHost = new WeakMap<HostAPI, ProviderState>();
const disposedHosts = new WeakSet<HostAPI>();

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function stateForHost(host: HostAPI): ProviderState {
  const state = statesByHost.get(host);
  if (state === undefined) {
    throw new ExtensionHost("system-prompt-file has not been initialised", undefined, {
      code: "LifecycleFailure",
    });
  }
  return state;
}

/**
 * Return true when `rawPath` contains a `..` component.
 *
 * Traversal paths that escape the declared scope are rejected before any I/O
 * or trust check. This covers both POSIX and Windows separators.
 */
function hasAncestorTraversal(rawPath: string): boolean {
  return rawPath
    .replace(/\\/g, "/")
    .split("/")
    .some((part) => part === "..");
}

function buildTurnEndHandler(host: HostAPI): (payload: unknown) => void {
  return (_payload: unknown): void => {
    const state = statesByHost.get(host);
    if (state !== undefined) {
      state.cachedContent = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

export async function init(host: HostAPI, config: SystemPromptFileConfig): Promise<void> {
  // 1. Defensive shape checks (schema enforces these, but verify at runtime).
  if (typeof config.path !== "string" || config.path.trim().length === 0) {
    throw new Validation("system-prompt-file path must be a non-empty string", undefined, {
      code: "ConfigSchemaViolation",
      field: "path",
    });
  }
  if (!Number.isInteger(config.tokenBudget) || config.tokenBudget < 0) {
    throw new Validation("tokenBudget must be a non-negative integer", undefined, {
      code: "ConfigSchemaViolation",
      field: "tokenBudget",
    });
  }

  // 2. Reject ancestor traversal before any I/O or trust evaluation.
  if (hasAncestorTraversal(config.path)) {
    throw new Validation(
      `path '${config.path}' contains an ancestor traversal component (..)`,
      undefined,
      { code: "ConfigSchemaViolation", field: "path" },
    );
  }

  // 3. Canonicalize the path to an absolute form.
  let resolvedPath: string;
  try {
    resolvedPath = resolve(config.path);
  } catch (err) {
    throw new ExtensionHost("cannot canonicalize path for system-prompt-file", err, {
      code: "LifecycleFailure",
    });
  }

  // 4. Trust gate: project-root paths are trusted automatically; external paths
  //    require explicit user confirmation via the Interaction Protocol.
  await checkPathTrust(resolvedPath, host);

  // 5. Subscribe to SessionTurnEnd to invalidate the per-turn read cache.
  const onTurnEnd = buildTurnEndHandler(host);
  host.events.on("SessionTurnEnd", onTurnEnd);

  statesByHost.set(host, {
    resolvedPath,
    tokenBudget: config.tokenBudget,
    cachedContent: null,
    onTurnEnd,
  });

  // Clear any stale disposed marker from a previous lifecycle on this host.
  disposedHosts.delete(host);
}

export function activate(_host: HostAPI): Promise<void> {
  // No-op. The provider is stateless beyond the cached read; `provide()` populates
  // it lazily on the first call each turn.
  return Promise.resolve();
}

export function deactivate(host: HostAPI): Promise<void> {
  const state = statesByHost.get(host);
  if (state !== undefined) {
    state.cachedContent = null;
  }
  return Promise.resolve();
}

export function dispose(host: HostAPI): Promise<void> {
  if (disposedHosts.has(host)) {
    return Promise.resolve();
  }
  disposedHosts.add(host);

  const state = statesByHost.get(host);
  if (state !== undefined) {
    host.events.off("SessionTurnEnd", state.onTurnEnd);
    statesByHost.delete(host);
  }
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Provide — called at COMPOSE_REQUEST stage by Context Assembly
// ---------------------------------------------------------------------------

export async function provide(host: HostAPI): Promise<readonly ContextFragment[]> {
  const state = stateForHost(host);

  // Use cached content when available (invalidated on SessionTurnEnd).
  state.cachedContent ??= await readFileContent(state.resolvedPath);

  const fragment: ContextFragment = {
    kind: "system-message",
    content: state.cachedContent,
    tokenBudget: state.tokenBudget,
    priority: 0,
  };

  return [fragment];
}
