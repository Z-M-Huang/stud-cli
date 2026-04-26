/**
 * Pure helper for building scope-tree nodes.
 *
 * Exposed as a standalone export so that consumers (e.g. TOOL_CALL fan-out in
 * the loop orchestrator) can create a child scope from an existing parent
 * without importing the full session-scope factory.
 *
 * `buildAbortTree` is a thin façade over the `Scope.child` method. It exists
 * so that call sites that only need to extend the tree do not need to import
 * `createSessionScope`.
 *
 * Wiki: core/Concurrency-and-Cancellation.md
 */

import type { Scope, ScopeKind } from "./scope.js";

/**
 * Create a child scope of `parent` with the given `kind`.
 *
 * The child's AbortSignal is automatically aborted when the parent's signal
 * aborts. Cancelling the child does not affect the parent.
 *
 * @param parent - an existing Scope (any kind)
 * @param kind   - the ScopeKind to assign to the new child
 * @returns      a new Scope that is a child of `parent`
 */
export function buildAbortTree(parent: Scope, kind: ScopeKind): Scope {
  return parent.child(kind);
}
