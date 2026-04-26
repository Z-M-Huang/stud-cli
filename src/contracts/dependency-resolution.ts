/**
 * Dependency Resolution — topological init/dispose ordering for extensions.
 *
 * Exports the `ExtensionDependencyDeclaration` type, the `ResolvedOrder` /
 * `DependencyResolutionResult` / `DependencyResolutionFailure` result envelopes,
 * the `resolveDependencies` pure function, and the `extensionDependencySchema`
 * AJV-compilable JSON-Schema.
 *
 * Resolution rules (AC-24):
 *   - Topological sort (Kahn's algorithm) with **lexicographic** tie-breaking on
 *     `extId` — the same input always produces the same order.
 *   - `initOrder` is the topological order; `disposeOrder` is its exact reverse.
 *   - A cycle → `ExtensionHost/DependencyCycle` failure.
 *   - A missing `dependsOn` target (by `extId` or `category`) → `ExtensionHost/DependencyMissing`.
 *   - This is a pure function: no I/O, no side effects.
 *
 * contractVersion: 1.0.0
 * Wiki: contracts/Dependency-Resolution.md + core/Extension-Lifecycle.md
 */
import { ExtensionHost } from "../core/errors/index.js";

import type { CategoryKind } from "./kinds.js";
import type { JSONSchemaObject } from "./state-slot.js";

export type { CategoryKind } from "./kinds.js";

// ---------------------------------------------------------------------------
// contractVersion — for CI drift-check alignment with the wiki page
// ---------------------------------------------------------------------------

/**
 * The `contractVersion` of this module as declared on
 * `../stud-cli.wiki/contracts/Dependency-Resolution.md`.
 *
 * Exported so `scripts/wiki-drift.ts` can compare the value in the wiki page's
 * `> contractVersion:` header against the value here without parsing source AST.
 * When the wiki page bumps, this constant bumps in the same PR per AC-107/AC-112.
 */
export const contractVersion = "1.0.0" as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single dependency reference: either a concrete extension ID or a category.
 *
 * - `{ kind: 'ext'; extId: string }` — depends on the named extension directly.
 * - `{ kind: 'category'; category: CategoryKind }` — depends on every loaded
 *   extension in that category (all must init before the dependent).
 *
 * Wiki: contracts/Dependency-Resolution.md § "Declarations"
 */
export type DependencyRef =
  | { readonly kind: "ext"; readonly extId: string }
  | { readonly kind: "category"; readonly category: CategoryKind };

/**
 * One extension's dependency declaration — the entry passed into the resolver
 * for every loaded extension.
 *
 * Wiki: contracts/Dependency-Resolution.md § "Declarations"
 */
export interface ExtensionDependencyDeclaration {
  readonly extId: string;
  readonly kind: CategoryKind;
  readonly dependsOn: readonly DependencyRef[];
}

/**
 * The two ordered sequences produced by a successful resolution.
 *
 * - `initOrder` — topological order with lexicographic tie-breaking; pass to
 *   `init` / `activate` in this order.
 * - `disposeOrder` — exact reverse of `initOrder`; pass to `deactivate` /
 *   `dispose` in this order so dependents shut down before their dependencies.
 *
 * Wiki: contracts/Dependency-Resolution.md § "Load order"
 */
export interface ResolvedOrder {
  readonly initOrder: readonly string[];
  readonly disposeOrder: readonly string[];
}

/** Successful resolution envelope. */
export interface DependencyResolutionResult {
  readonly ok: true;
  readonly order: ResolvedOrder;
}

/**
 * Failed resolution envelope.
 *
 * `error.context.code` is one of:
 *   - `'DependencyCycle'`   — cycle detected; `error.context.participants` names the extIds.
 *   - `'DependencyMissing'` — a `dependsOn` target is absent from the declarations set.
 *
 * Wiki: contracts/Dependency-Resolution.md § "Diagnostic shape"
 */
export interface DependencyResolutionFailure {
  readonly ok: false;
  readonly error: ExtensionHost;
}

// ---------------------------------------------------------------------------
// extensionDependencySchema — AJV-compilable JSON-Schema
// ---------------------------------------------------------------------------

/**
 * JSON-Schema 2020-12 document that validates one `ExtensionDependencyDeclaration`.
 *
 * Three canonical fixtures:
 *   valid         — `{ extId: 'a', kind: 'Tool', dependsOn: [] }`
 *   invalid       — `{ extId: 'a', kind: 'Bogus', dependsOn: [] }` → rejected at `/kind`
 *   worstPlausible — extra keys → rejected by `additionalProperties: false`
 *
 * Wiki: contracts/Dependency-Resolution.md
 */
export const extensionDependencySchema: JSONSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["extId", "kind", "dependsOn"],
  properties: {
    extId: { type: "string", minLength: 1 },
    kind: {
      type: "string",
      enum: [
        "Provider",
        "Tool",
        "Hook",
        "UI",
        "Logger",
        "StateMachine",
        "Command",
        "SessionStore",
        "ContextProvider",
      ],
    },
    dependsOn: {
      type: "array",
      items: {
        type: "object",
        oneOf: [
          {
            additionalProperties: false,
            required: ["kind", "extId"],
            properties: {
              kind: { type: "string", enum: ["ext"] },
              extId: { type: "string", minLength: 1 },
            },
          },
          {
            additionalProperties: false,
            required: ["kind", "category"],
            properties: {
              kind: { type: "string", enum: ["category"] },
              category: {
                type: "string",
                enum: [
                  "Provider",
                  "Tool",
                  "Hook",
                  "UI",
                  "Logger",
                  "StateMachine",
                  "Command",
                  "SessionStore",
                  "ContextProvider",
                ],
              },
            },
          },
        ],
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Internal — graph build result (discriminated union for safe narrowing)
// ---------------------------------------------------------------------------

interface BuildGraphSuccess {
  readonly ok: true;
  readonly byId: Map<string, ExtensionDependencyDeclaration>;
  readonly adjacency: Map<string, Set<string>>;
  readonly inDegree: Map<string, number>;
}

type BuildGraphResult = BuildGraphSuccess | DependencyResolutionFailure;

// ---------------------------------------------------------------------------
// buildGraph — index + edge population
// ---------------------------------------------------------------------------

function buildGraph(decls: readonly ExtensionDependencyDeclaration[]): BuildGraphResult {
  const byId = new Map<string, ExtensionDependencyDeclaration>();
  const byCategory = new Map<CategoryKind, string[]>();
  const adjacency = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  for (const decl of decls) {
    byId.set(decl.extId, decl);
    const catList = byCategory.get(decl.kind);
    if (catList !== undefined) {
      catList.push(decl.extId);
    } else {
      byCategory.set(decl.kind, [decl.extId]);
    }
    adjacency.set(decl.extId, new Set());
    inDegree.set(decl.extId, 0);
  }

  for (const decl of decls) {
    for (const dep of decl.dependsOn) {
      if (dep.kind === "ext") {
        if (!byId.has(dep.extId)) {
          return {
            ok: false,
            error: new ExtensionHost(
              `extension '${decl.extId}' depends on '${dep.extId}' which is not declared`,
              undefined,
              { code: "DependencyMissing", dependentId: decl.extId, missingId: dep.extId },
            ),
          };
        }
        adjacency.get(dep.extId)!.add(decl.extId);
        inDegree.set(decl.extId, inDegree.get(decl.extId)! + 1);
      } else {
        const categoryIds = byCategory.get(dep.category);
        if (categoryIds === undefined || categoryIds.length === 0) {
          return {
            ok: false,
            error: new ExtensionHost(
              `extension '${decl.extId}' depends on category '${dep.category}' which has no loaded members`,
              undefined,
              { code: "DependencyMissing", dependentId: decl.extId, missingCategory: dep.category },
            ),
          };
        }
        for (const depId of categoryIds) {
          if (depId === decl.extId) continue;
          adjacency.get(depId)!.add(decl.extId);
          inDegree.set(decl.extId, inDegree.get(decl.extId)! + 1);
        }
      }
    }
  }

  return { ok: true, byId, adjacency, inDegree };
}

// ---------------------------------------------------------------------------
// kahnSort — Kahn's algorithm with lexicographic tie-breaking
// ---------------------------------------------------------------------------

function kahnSort(adjacency: Map<string, Set<string>>, inDegree: Map<string, number>): string[] {
  const remaining = new Map(inDegree);
  const queue: string[] = [];

  for (const [id, deg] of remaining) {
    if (deg === 0) queue.push(id);
  }
  queue.sort();

  const order: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);

    const newReady: string[] = [];
    for (const neighbor of [...adjacency.get(node)!].sort()) {
      const deg = remaining.get(neighbor)! - 1;
      remaining.set(neighbor, deg);
      if (deg === 0) newReady.push(neighbor);
    }

    if (newReady.length > 0) {
      queue.push(...newReady);
      queue.sort();
    }
  }

  return order;
}

// ---------------------------------------------------------------------------
// resolveDependencies — public pure resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the topological init/dispose ordering for a set of extension declarations.
 *
 * Algorithm: Kahn's algorithm with a lexicographically-sorted queue for
 * deterministic tie-breaking. Extensions with no unsatisfied dependencies are
 * admitted in `extId` alphabetical order at each step.
 *
 * Failure cases:
 *   - `ExtensionHost/DependencyCycle` — at least one cycle exists.
 *   - `ExtensionHost/DependencyMissing` — a `dependsOn` entry names an `extId`
 *     not present in `declarations`, or a `category` with zero members.
 *
 * Wiki: contracts/Dependency-Resolution.md
 */
export function resolveDependencies(
  declarations: readonly ExtensionDependencyDeclaration[],
): DependencyResolutionResult | DependencyResolutionFailure {
  const graph = buildGraph(declarations);
  if (!graph.ok) return graph;

  const initOrder = kahnSort(graph.adjacency, graph.inDegree);

  if (initOrder.length !== declarations.length) {
    const participants = [...graph.byId.keys()].filter((id) => !initOrder.includes(id));
    return {
      ok: false,
      error: new ExtensionHost(
        `dependency cycle detected among extensions: ${participants.join(", ")}`,
        undefined,
        { code: "DependencyCycle", participants },
      ),
    };
  }

  return {
    ok: true,
    order: {
      initOrder: Object.freeze(initOrder),
      disposeOrder: Object.freeze([...initOrder].reverse()),
    },
  };
}
