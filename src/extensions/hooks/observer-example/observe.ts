/**
 * Observer implementation for the observer-example reference hook.
 *
 * Attaches to TOOL_CALL/post. For each tool invocation, appends a
 * ToolDurationRecord to the extension's own state slot and emits a
 * `SlowTool` observability event if the duration exceeds the configured
 * threshold.
 *
 * This handler is strictly read-only with respect to the tool result:
 * it returns void and never mutates the payload.
 *
 * Wiki: reference-extensions/hooks/Observer.md
 */
import type { ToolDurationRecord } from "./record.js";
import type { ObserverHandler } from "../../../contracts/hooks.js";
import type { HostAPI } from "../../../core/host/host-api.js";

/** The extension's own manifest key — used for state-slot access. */
export const EXT_ID = "observer-example";

/** Default slow-tool threshold in milliseconds. */
const DEFAULT_THRESHOLD_MS = 5000;

/** Per-host observer configuration, stored at init time. */
interface ObserverState {
  readonly slowToolThresholdMs: number;
}

const stateByHost = new WeakMap<HostAPI, ObserverState>();

/**
 * Payload shape at the TOOL_CALL/post hook slot.
 *
 * `startedAt` and `endedAt` are nanosecond-precision monotonic timestamps
 * provided by the runtime. `result` is the tool output (present on post;
 * the observer must not mutate it).
 */
export interface ToolCallPostPayload {
  readonly toolId: string;
  readonly invocationId: string;
  readonly approvalKey?: string;
  readonly startedAt: bigint;
  readonly endedAt: bigint;
  readonly result?: unknown;
}

/**
 * Stores per-host observer configuration. Called from `lifecycle.init`.
 * Overwrites any previously stored state for this host.
 */
export function initObserver(host: HostAPI, slowToolThresholdMs: number): void {
  stateByHost.set(host, { slowToolThresholdMs });
}

/**
 * Removes per-host observer state. Called from `lifecycle.dispose`.
 * Safe to call multiple times (idempotent WeakMap.delete).
 */
export function disposeObserver(host: HostAPI): void {
  stateByHost.delete(host);
}

/**
 * Observer handler — records tool-call duration and emits SlowTool if needed.
 *
 * Reads the current records from the state slot, appends the new record, and
 * writes the updated list back. Emits a `SlowTool` observability event when
 * `durationMs` exceeds the configured threshold.
 *
 * Returns void — the observer sub-kind never modifies the tool result.
 */
export const observe: ObserverHandler<ToolCallPostPayload> = async (
  payload: Readonly<ToolCallPostPayload>,
  host: HostAPI,
): Promise<void> => {
  const durationMs = Number(payload.endedAt - payload.startedAt) / 1_000_000;

  const record: ToolDurationRecord = {
    toolId: payload.toolId,
    invocationId: payload.invocationId,
    approvalKey: payload.approvalKey ?? "",
    startedAt: payload.startedAt,
    endedAt: payload.endedAt,
    durationMs,
  };

  const slot = host.session.stateSlot(EXT_ID);
  const rawState = await slot.read();

  const existingRaw = rawState !== null ? rawState["records"] : undefined;
  const existing: readonly ToolDurationRecord[] = Array.isArray(existingRaw)
    ? (existingRaw as readonly ToolDurationRecord[])
    : [];

  await slot.write({ records: [...existing, record] });

  const state = stateByHost.get(host);
  const threshold = state !== undefined ? state.slowToolThresholdMs : DEFAULT_THRESHOLD_MS;

  if (durationMs > threshold) {
    host.observability.emit({
      type: "SlowTool",
      payload: {
        toolId: payload.toolId,
        invocationId: payload.invocationId,
        durationMs,
        threshold,
      },
    });
  }
};
