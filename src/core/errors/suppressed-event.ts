/**
 * Structural type for the SuppressedError observability event.
 *
 * Emitted by any catch block that intentionally swallows an error instead of
 * propagating it. The emitter (Event Bus unit) uses this shape; this module
 * only fixes the type.
 *
 * Wiki: core/Error-Model.md § "Empty catch is non-conformant".
 */
export interface SuppressedErrorEvent {
  readonly type: "SuppressedError";
  /** Human-readable rationale for the suppression. */
  readonly reason: string;
  /** Serialized error (String(err)) — never a resolved secret. */
  readonly cause: string;
  /** Monotonic timestamp (Date.now() or performance.now() cast to number). */
  readonly at: number;
}
