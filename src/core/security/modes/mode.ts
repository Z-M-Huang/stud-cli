/**
 * Session-fixed security modes.
 *
 * `resolveSessionMode` is called exactly once, at session start, before the
 * first `RECEIVE_INPUT` stage. The returned `SecurityModeRecord` is frozen;
 * there is no `setMode()` or other mutator — invariant #3.
 *
 * Allowlist union rule:
 *   allowlist = deduplicated, lexicographically sorted set union of
 *               bundled ∪ global ∪ project allowlist entries.
 *
 * Wiki: security/Security-Modes.md
 */

import { Validation } from "../../errors/validation.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The three permitted security modes. Mode is session-fixed (invariant #3). */
export type SecurityMode = "ask" | "yolo" | "allowlist";

/**
 * An immutable snapshot of the security mode resolved at session start.
 * Stored on the session manifest by ; never mutated after creation.
 */
export interface SecurityModeRecord {
  /** The resolved mode. */
  readonly mode: SecurityMode;
  /**
   * Approval-key patterns that gate tool execution in `allowlist` mode.
   * Empty for `ask` and `yolo` modes.
   */
  readonly allowlist: readonly string[];
  /** ISO-8601 instant at which the mode was resolved (session-start). */
  readonly setAt: string;
}

/**
 * Input to `resolveSessionMode`.
 *
 * `launchArg` is the mode passed via `--mode` or the headless launch flow.
 * When provided it takes precedence over all scope settings.
 *
 * `settingsByScope` carries the per-scope fragments as loaded by the config
 * subsystem ( merge order: bundled → global → project). This module
 * receives all three fragments so it can compute the additive allowlist union.
 */
export interface ModeResolverInput {
  readonly launchArg: SecurityMode | undefined;
  readonly settingsByScope: {
    readonly bundled: { mode?: SecurityMode; allowlist?: readonly string[] };
    readonly global: { mode?: SecurityMode; allowlist?: readonly string[] };
    readonly project: { mode?: SecurityMode; allowlist?: readonly string[] };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_MODES: ReadonlySet<string> = new Set(["ask", "yolo", "allowlist"]);

function assertValidMode(value: unknown, location: string): asserts value is SecurityMode {
  if (typeof value !== "string" || !VALID_MODES.has(value)) {
    throw new Validation(
      `Security mode "${String(value)}" declared in ${location} is not one of ask | yolo | allowlist`,
      undefined,
      { code: "InvalidSecurityMode", declared: value, location },
    );
  }
}

/**
 * Collect every allowlist entry from all three scopes and return the
 * deduplicated, lexicographically sorted union.
 */
function mergeAllowlists(
  bundled: readonly string[] | undefined,
  global: readonly string[] | undefined,
  project: readonly string[] | undefined,
): readonly string[] {
  const seen = new Set<string>();
  for (const entry of [...(bundled ?? []), ...(global ?? []), ...(project ?? [])]) {
    seen.add(entry);
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// resolveSessionMode
// ---------------------------------------------------------------------------

/**
 * Collapse `(launchArg, settingsByScope)` into a frozen `SecurityModeRecord`.
 *
 * Resolution rules:
 *  1. Validate every declared mode field against the three-value enum.
 *  2. `launchArg` wins if provided.
 *  3. Effective mode falls back to: project → global → bundled → "ask".
 *  4. Allowlist is the set union of all three scopes, sorted.
 *  5. If allowlist entries exist but the effective mode is not "allowlist",
 *     throw `Validation/AllowlistWithoutMode`.
 *  6. The record is frozen before returning.
 */
export function resolveSessionMode(input: ModeResolverInput): SecurityModeRecord {
  const { launchArg, settingsByScope } = input;
  const { bundled, global, project } = settingsByScope;

  // Validate all declared mode values.
  if (launchArg !== undefined) {
    assertValidMode(launchArg, "launchArg");
  }
  if (bundled.mode !== undefined) {
    assertValidMode(bundled.mode, "settingsByScope.bundled");
  }
  if (global.mode !== undefined) {
    assertValidMode(global.mode, "settingsByScope.global");
  }
  if (project.mode !== undefined) {
    assertValidMode(project.mode, "settingsByScope.project");
  }

  // Resolve effective mode: launchArg > project > global > bundled > "ask".
  const effectiveMode: SecurityMode =
    launchArg ?? project.mode ?? global.mode ?? bundled.mode ?? "ask";

  // Compute the additive allowlist union across all scopes.
  const mergedAllowlist = mergeAllowlists(bundled.allowlist, global.allowlist, project.allowlist);

  // Determine whether any scope explicitly declared mode="allowlist".
  // When at least one scope does, the allowlist entries are internally consistent
  // at the scope level — even if the launchArg overrides the effective mode away
  // from "allowlist". Silently discard the entries in that case.
  //
  // The error fires only when NO source (launchArg or scope) declared
  // mode="allowlist" yet allowlist entries are present — that is an
  // orphaned/misconfigured allowlist with no owning mode declaration.
  const anyAllowlistModeDeclaration =
    launchArg === "allowlist" ||
    bundled.mode === "allowlist" ||
    global.mode === "allowlist" ||
    project.mode === "allowlist";

  if (mergedAllowlist.length > 0 && effectiveMode !== "allowlist") {
    if (!anyAllowlistModeDeclaration) {
      throw new Validation(
        `Allowlist entries declared but effective security mode is "${effectiveMode}", not "allowlist"`,
        undefined,
        { code: "AllowlistWithoutMode", effectiveMode, entryCount: mergedAllowlist.length },
      );
    }
    // A scope declared mode="allowlist" but the launchArg overrode the effective
    // mode — the allowlist entries are discarded silently (the override wins).
  }

  const record: SecurityModeRecord = {
    mode: effectiveMode,
    allowlist: effectiveMode === "allowlist" ? mergedAllowlist : [],
    setAt: new Date().toISOString(),
  };

  return Object.freeze(record);
}
