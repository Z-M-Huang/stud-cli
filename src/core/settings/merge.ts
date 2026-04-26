/**
 * Settings merge — scope-layered merge for `settings.json`.
 *
 * Merge policy (project > global > bundled):
 *   - Per-category maps (`providers`, `tools`, `hooks`, `ui`, `loggers`,
 *     `stateMachines`, `commands`, `sessionStores`, `contextProviders`):
 *     shallow-merged; project-scope key wins on collision.
 *   - `env`: shallow-merged; project-scope key wins on collision.
 *   - `logging`: shallow-merged; project-scope key wins on collision.
 *   - `active`: shallow-merged; project-scope field wins on collision.
 *   - `securityMode.mode`: project > global > bundled (scalar — highest wins).
 *   - `securityMode.allowlist`: additive union across all three scopes
 *     (bundled ∪ global ∪ project, preserving encounter order, deduped).
 *
 * Pure function — no side effects.
 *
 * Wiki: contracts/Settings-Shape.md + runtime/Configuration-Scopes.md +
 *       flows/Scope-Layering.md
 */

import type { Settings } from "./shape.js";

// ---------------------------------------------------------------------------
// Category maps merged by shallow-merge (project wins)
// ---------------------------------------------------------------------------

type CategoryKey = Extract<
  keyof Settings,
  | "providers"
  | "tools"
  | "hooks"
  | "ui"
  | "loggers"
  | "stateMachines"
  | "commands"
  | "sessionStores"
  | "contextProviders"
  | "logging"
>;

const CATEGORY_KEYS: readonly CategoryKey[] = [
  "providers",
  "tools",
  "hooks",
  "ui",
  "loggers",
  "stateMachines",
  "commands",
  "sessionStores",
  "contextProviders",
  "logging",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge up to three Settings scopes into one view.
 *
 * Any argument may be `undefined` (scope not present for this session).
 *
 * @param bundled — bundled (lowest-priority) scope.
 * @param global  — global user scope.
 * @param project — project scope (highest-priority).
 * @returns       merged `Settings` object.
 */
export function mergeSettings(
  bundled: Settings | undefined,
  global: Settings | undefined,
  project: Settings | undefined,
): Settings {
  const result: Record<string, unknown> = {};

  // -- env -----------------------------------------------------------------
  const bEnv = bundled?.env;
  const gEnv = global?.env;
  const pEnv = project?.env;
  if (bEnv !== undefined || gEnv !== undefined || pEnv !== undefined) {
    result["env"] = { ...bEnv, ...gEnv, ...pEnv };
  }

  // -- securityMode --------------------------------------------------------
  const bSec = bundled?.securityMode;
  const gSec = global?.securityMode;
  const pSec = project?.securityMode;
  if (bSec !== undefined || gSec !== undefined || pSec !== undefined) {
    // Scalar mode: project > global > bundled.
    const mode = pSec?.mode ?? gSec?.mode ?? bSec?.mode;

    // Allowlist: additive union (bundled ∪ global ∪ project), deduped.
    const seen = new Set<string>();
    const allowlist: string[] = [];
    for (const item of [
      ...(bSec?.allowlist ?? []),
      ...(gSec?.allowlist ?? []),
      ...(pSec?.allowlist ?? []),
    ]) {
      if (!seen.has(item)) {
        seen.add(item);
        allowlist.push(item);
      }
    }

    const securityMode: Record<string, unknown> = {};
    if (mode !== undefined) {
      securityMode["mode"] = mode;
    }
    if (allowlist.length > 0) {
      securityMode["allowlist"] = allowlist;
    }
    result["securityMode"] = securityMode;
  }

  // -- per-category maps + logging -----------------------------------------
  for (const key of CATEGORY_KEYS) {
    const b = bundled?.[key] as Record<string, unknown> | undefined;
    const g = global?.[key] as Record<string, unknown> | undefined;
    const p = project?.[key] as Record<string, unknown> | undefined;
    if (b !== undefined || g !== undefined || p !== undefined) {
      result[key] = { ...b, ...g, ...p };
    }
  }

  // -- active --------------------------------------------------------------
  const bActive = bundled?.active;
  const gActive = global?.active;
  const pActive = project?.active;
  if (bActive !== undefined || gActive !== undefined || pActive !== undefined) {
    result["active"] = { ...bActive, ...gActive, ...pActive };
  }

  return result as Settings;
}
