/**
 * Provenance-preserving runtime params store with **per-leaf-path** tracking.
 *
 * Wiki: contracts/Provider-Params.md § "Merge layers — precedence";
 *       operations/Audit-Trail.md § "Audit records as redacted deltas".
 *
 * Each leaf path (e.g., `["thinkingConfig", "thinkingLevel"]`) carries its own
 * `sourceLayer` so that nested-default + `/params` merges report accurate
 * provenance for `paramsAffected[]` and audit. Runtime overrides
 * (`--param`, `/params`) are kept in memory only and NOT persisted to the
 * session manifest — resume re-applies `defaultParams` only.
 */

export type ParamSourceLayer = "defaultParams" | "launch" | "/params";

export interface ParamEntry {
  readonly value: unknown;
  readonly sourceLayer: ParamSourceLayer;
}

export interface ParamPathEntry {
  readonly paramPath: readonly string[];
  readonly sourceLayer: ParamSourceLayer;
  readonly value: unknown;
}

export interface ParamsRuntimeStore {
  /**
   * Top-level effective view, value+source per top-level key. Provenance is
   * the layer of the LAST-writing leaf descending from that key. For
   * accurate per-leaf provenance use `get(path)`.
   */
  getEffective(): Readonly<Record<string, ParamEntry>>;
  /**
   * Per-leaf-path lookup. Returns `{ value, sourceLayer }` where
   * `sourceLayer` is the layer that wrote that exact leaf (or, for an
   * internal-node lookup, the closest written descendant).
   */
  get(path: readonly string[]): ParamEntry | undefined;
  /** Per-leaf-path provenance for a given path. */
  sourceLayerAt(path: readonly string[]): ParamSourceLayer | undefined;
  /** Set a runtime override; sourceLayer is "launch" or "/params". */
  set(path: readonly string[], value: unknown, sourceLayer: "launch" | "/params"): void;
  /** Snapshot for audit/event emission. One entry per leaf with provenance. */
  snapshot(): readonly ParamPathEntry[];
  /** Plain merged params bag (provenance stripped) — what the bridge consumes. */
  asMergedBag(): Readonly<Record<string, unknown>>;
  /**
   * Replace the `defaultParams` layer (called on `/provider` switch). Runtime
   * overrides (`launch`, `/params`) are preserved per `wiki/runtime/Launch-Arguments.md:97`.
   */
  applyDefaultParams(defaultParams: Readonly<Record<string, unknown>>): void;
  /**
   * Compute what `asMergedBag()` would return AFTER `applyDefaultParams(next)`
   * runs — without mutating the store. Used to validate a destination entry
   * BEFORE publishing the swap.
   */
  projectMergedBagWithDefaults(
    next: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>>;
}

interface LeafEntry {
  readonly value: unknown;
  readonly sourceLayer: ParamSourceLayer;
}

type LeafMap = Map<string, { path: readonly string[]; entry: LeafEntry }>;

function pathKey(path: readonly string[]): string {
  return path.join(" ");
}

function flattenLeaves(
  obj: Readonly<Record<string, unknown>>,
  parentPath: readonly string[],
  sourceLayer: ParamSourceLayer,
  out: LeafMap,
): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = [...parentPath, key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      flattenLeaves(value as Readonly<Record<string, unknown>>, path, sourceLayer, out);
    } else {
      out.set(pathKey(path), { path, entry: { value, sourceLayer } });
    }
  }
}

function leafMapToTree(
  leaves: ReadonlyMap<string, { path: readonly string[]; entry: LeafEntry }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { path, entry } of leaves.values()) {
    let cursor: Record<string, unknown> = out;
    for (let i = 0; i < path.length - 1; i += 1) {
      const seg = path[i]!;
      const next = cursor[seg];
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        cursor[seg] = {};
      }
      cursor = cursor[seg] as Record<string, unknown>;
    }
    cursor[path[path.length - 1]!] = entry.value;
  }
  return out;
}

function readEffective(leaves: LeafMap): Readonly<Record<string, ParamEntry>> {
  const out: Record<string, ParamEntry> = {};
  const tree = leafMapToTree(leaves);
  const topProvenance = new Map<string, ParamSourceLayer>();
  for (const { path, entry } of leaves.values()) {
    topProvenance.set(path[0]!, entry.sourceLayer);
  }
  for (const [key, value] of Object.entries(tree)) {
    out[key] = { value, sourceLayer: topProvenance.get(key) ?? "defaultParams" };
  }
  return out;
}

function readPath(leaves: LeafMap, path: readonly string[]): ParamEntry | undefined {
  if (path.length === 0) return undefined;
  const exact = leaves.get(pathKey(path));
  if (exact !== undefined) return exact.entry;
  let cursor: unknown = leafMapToTree(leaves);
  for (const seg of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
    if (cursor === undefined) return undefined;
  }
  const prefix = pathKey(path) + " ";
  let lastLayer: ParamSourceLayer = "defaultParams";
  for (const [k, e] of leaves.entries()) {
    if (k.startsWith(prefix)) lastLayer = e.entry.sourceLayer;
  }
  return { value: cursor, sourceLayer: lastLayer };
}

function writePath(
  leaves: LeafMap,
  path: readonly string[],
  value: unknown,
  sourceLayer: "launch" | "/params",
): void {
  if (path.length === 0) return;
  const prefix = pathKey(path);
  for (const k of [...leaves.keys()]) {
    if (k === prefix || k.startsWith(prefix + " ")) leaves.delete(k);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    flattenLeaves(value as Readonly<Record<string, unknown>>, path, sourceLayer, leaves);
  } else {
    leaves.set(prefix, { path, entry: { value, sourceLayer } });
  }
}

function applyNewDefaults(leaves: LeafMap, defaultParams: Readonly<Record<string, unknown>>): void {
  for (const [k, { entry }] of [...leaves.entries()]) {
    if (entry.sourceLayer === "defaultParams") leaves.delete(k);
  }
  const fresh: LeafMap = new Map();
  flattenLeaves(defaultParams, [], "defaultParams", fresh);
  for (const [k, v] of fresh) {
    if (!leaves.has(k)) leaves.set(k, v);
  }
}

function projectWithDefaults(
  leaves: LeafMap,
  next: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const projected: LeafMap = new Map();
  flattenLeaves(next, [], "defaultParams", projected);
  for (const [k, v] of leaves.entries()) {
    if (v.entry.sourceLayer !== "defaultParams") projected.set(k, v);
  }
  return leafMapToTree(projected);
}

export function createParamsRuntimeStore(opts: {
  readonly defaultParams?: Readonly<Record<string, unknown>>;
}): ParamsRuntimeStore {
  const leaves: LeafMap = new Map();
  if (opts.defaultParams !== undefined) {
    flattenLeaves(opts.defaultParams, [], "defaultParams", leaves);
  }
  return {
    getEffective: () => readEffective(leaves),
    get: (path) => readPath(leaves, path),
    sourceLayerAt: (path) => readPath(leaves, path)?.sourceLayer,
    set: (path, value, sourceLayer) => {
      writePath(leaves, path, value, sourceLayer);
    },
    snapshot: () =>
      [...leaves.values()].map(({ path, entry }) => ({
        paramPath: path,
        sourceLayer: entry.sourceLayer,
        value: entry.value,
      })),
    asMergedBag: () => leafMapToTree(leaves),
    applyDefaultParams: (defaultParams) => {
      applyNewDefaults(leaves, defaultParams);
    },
    projectMergedBagWithDefaults: (next) => projectWithDefaults(leaves, next),
  };
}

/**
 * Helper that creates a runtime store seeded with a provider's
 * `defaultParams` and applies launch-time `--param` overrides. Used by both
 * fresh-session and resume bootstrap paths.
 */
export function buildSessionParamsStore(
  defaultParams: Readonly<Record<string, unknown>> | undefined,
  launchOverrides: readonly { readonly path: readonly string[]; readonly value: unknown }[],
): ParamsRuntimeStore {
  const store = createParamsRuntimeStore({
    ...(defaultParams !== undefined ? { defaultParams } : {}),
  });
  for (const param of launchOverrides) {
    store.set(param.path, param.value, "launch");
  }
  return store;
}
