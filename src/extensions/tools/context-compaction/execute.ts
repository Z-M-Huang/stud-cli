/**
 * Executor for the context-compaction reference tool.
 *
 * Invokes the compaction subsystem for the current session's history, persists
 * the result through the active Session Store, emits a `Compaction` audit
 * record, and returns a summary of what was compacted.
 *
 * Approval gate: `deriveApprovalKey` returns the fixed string
 * `"context-compaction"`. One approval per session covers all invocations.
 *
 * Error protocol:
 *   - Throws `Validation/ConfigSchemaViolation` when args are out of range
 *     (negative, over-100 percent), before any I/O.
 *   - Returns `{ ok: false, error: ToolTerminal/OutputMalformed }` when the
 *     compaction subsystem returns a malformed summary.
 *   - Throws `Session/StoreUnavailable` when the post-compaction persist fails.
 *   - Throws `Cancellation/TurnCancelled` when the abort signal is set.
 *
 * Side effects:
 *   - Writes the compaction summary to the extension's state slot (Session Store).
 *   - Emits one `Compaction` audit record (no message content — invariant #6).
 *
 * Wiki: reference-extensions/tools/Context-Compaction.md
 */
import { Cancellation, Session, ToolTerminal, Validation } from "../../../core/errors/index.js";

import { getConfig } from "./lifecycle.js";

import type { CompactionArgs } from "./args.js";
import type { CompactionSummary } from "./result.js";
import type { ToolReturn } from "../../../contracts/tools.js";
import type { HostAPI } from "../../../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Compact function abstraction
// ---------------------------------------------------------------------------

/**
 * Compact function signature.
 *
 * In production, the framework injects the real implementation that has access
 * to the session's message history. In the reference implementation, the
 * default compact function returns a stub summary that demonstrates the
 * contract shape.
 *
 * v1 note: `HostAPI` does not expose session history directly. The real
 * implementation must be wired by the framework at session start.
 */
type CompactFn = (args: CompactionArgs, host: HostAPI) => Promise<CompactionSummary>;

/**
 * Default compact function for the reference implementation.
 *
 * Returns a stub summary because v1 `HostAPI` does not expose the session
 * message history. The framework replaces this by injecting the real compact
 * function when wiring the extension at session start.
 */
const defaultCompactFn: CompactFn = (
  _args: CompactionArgs,
  _host: HostAPI,
): Promise<CompactionSummary> =>
  Promise.resolve({
    compactedSegments: 0,
    originalTokens: 0,
    compactedTokens: 0,
    newUtilizationPercent: 0,
    summary:
      "reference default: v1 HostAPI does not expose session history; " +
      "framework must wire the real compact function at session start",
  });

// Module-level compact function — replaced by the framework or by tests.
let _compactFn: CompactFn = defaultCompactFn;

/**
 * Override the compact function used by `executeContextCompaction`.
 *
 * Pass `undefined` to restore the default (stub) implementation.
 * This is the injection point for the framework and for tests.
 */
export function setCompactFn(fn: CompactFn | undefined): void {
  _compactFn = fn ?? defaultCompactFn;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXT_ID = "context-compaction";
const MAX_UTILIZATION_PERCENT = 100;
const DEFAULT_TARGET_UTILIZATION = 80;
const DEFAULT_PRESERVE_RECENT_TURNS = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTargetUtilization(
  args: CompactionArgs,
  config: ReturnType<typeof getConfig>,
): number {
  return (
    args.targetUtilizationPercent ??
    config.defaultTargetUtilizationPercent ??
    DEFAULT_TARGET_UTILIZATION
  );
}

function resolvePreserveRecentTurns(
  args: CompactionArgs,
  config: ReturnType<typeof getConfig>,
): number {
  return (
    args.preserveRecentTurns ?? config.defaultPreserveRecentTurns ?? DEFAULT_PRESERVE_RECENT_TURNS
  );
}

function isSummaryShape(value: unknown): value is CompactionSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["compactedSegments"] === "number" &&
    typeof v["originalTokens"] === "number" &&
    typeof v["compactedTokens"] === "number" &&
    typeof v["newUtilizationPercent"] === "number" &&
    typeof v["summary"] === "string"
  );
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeContextCompaction(
  args: CompactionArgs,
  host: HostAPI,
  signal: AbortSignal,
): Promise<ToolReturn<CompactionSummary>> {
  // Validate args before any I/O.
  if (
    args.targetUtilizationPercent !== undefined &&
    (args.targetUtilizationPercent < 0 || args.targetUtilizationPercent > MAX_UTILIZATION_PERCENT)
  ) {
    throw new Validation(
      `targetUtilizationPercent must be between 0 and 100, got ${args.targetUtilizationPercent}`,
      undefined,
      {
        code: "ConfigSchemaViolation",
        field: "targetUtilizationPercent",
        value: args.targetUtilizationPercent,
      },
    );
  }

  if (args.preserveRecentTurns !== undefined && args.preserveRecentTurns < 0) {
    throw new Validation(
      `preserveRecentTurns must be non-negative, got ${args.preserveRecentTurns}`,
      undefined,
      {
        code: "ConfigSchemaViolation",
        field: "preserveRecentTurns",
        value: args.preserveRecentTurns,
      },
    );
  }

  // Honor abort signal — cooperative cancellation before any I/O.
  if (signal.aborted) {
    throw new Cancellation("execution aborted before start", undefined, {
      code: "TurnCancelled",
    });
  }

  const config = getConfig();
  const resolvedArgs: CompactionArgs = {
    targetUtilizationPercent: resolveTargetUtilization(args, config),
    preserveRecentTurns: resolvePreserveRecentTurns(args, config),
  };

  // Invoke the compaction subsystem.
  let result: CompactionSummary;
  try {
    const raw = await _compactFn(resolvedArgs, host);
    if (!isSummaryShape(raw)) {
      return {
        ok: false,
        error: new ToolTerminal("compaction subsystem returned malformed summary", undefined, {
          code: "OutputMalformed",
        }),
      };
    }
    result = raw;
  } catch (err) {
    // Cooperative cancellation propagates unchanged.
    if (err instanceof Cancellation) throw err;
    return {
      ok: false,
      error: new ToolTerminal("compaction subsystem returned unreadable summary", err, {
        code: "OutputMalformed",
      }),
    };
  }

  // Persist the compaction summary through the active Session Store before
  // returning, so that a crash after compaction does not lose the new state.
  try {
    await host.session.stateSlot(EXT_ID).write({
      compactedSegments: result.compactedSegments,
      originalTokens: result.originalTokens,
      compactedTokens: result.compactedTokens,
      newUtilizationPercent: result.newUtilizationPercent,
      persistedAt: Date.now(),
    });
  } catch (err) {
    // Re-throw Session errors (e.g. StoreUnavailable) as-is.
    if (err instanceof Session) throw err;
    // Wrap unexpected persist failures as StoreUnavailable.
    throw new Session("active Session Store unavailable during post-compaction persist", err, {
      code: "StoreUnavailable",
    });
  }

  // Emit one Compaction audit record.
  // Never include message content — invariant #6.
  await host.audit.write({
    severity: "info",
    code: "Compaction",
    message: "context compaction completed",
    context: {
      compactedSegments: result.compactedSegments,
      originalTokens: result.originalTokens,
      compactedTokens: result.compactedTokens,
      newUtilizationPercent: result.newUtilizationPercent,
    },
  });

  return { ok: true, value: result };
}
