/**
 * ToolDurationRecord — single tool-call timing observation persisted to the
 * observer-example state slot.
 *
 * `startedAt` / `endedAt` are nanosecond-precision monotonic timestamps
 * supplied by the runtime in the TOOL_CALL/post payload.
 * `durationMs` is derived: `Number(endedAt - startedAt) / 1_000_000`.
 *
 * Wiki: reference-extensions/hooks/Observer.md
 */

export interface ToolDurationRecord {
  readonly toolId: string;
  readonly invocationId: string;
  readonly approvalKey: string;
  readonly startedAt: bigint;
  readonly endedAt: bigint;
  readonly durationMs: number;
}
