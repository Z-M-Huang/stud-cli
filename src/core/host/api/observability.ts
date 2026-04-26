/**
 * ObservabilityAPI — projection event emission surface for extensions.
 *
 * Extensions emit observability events (metrics, traces, diagnostic signals)
 * through this surface. Core routes the events to all registered Logger
 * extensions. The `SuppressedError` event is the mandatory signal for
 * intentionally swallowed errors (see error-model anti-pattern "Empty catch").
 *
 * This surface is write-only: extensions emit events and do not subscribe
 * to their own emissions here. Subscriptions use `EventsAPI.on`.
 *
 * Wiki: core/Host-API.md + core/Error-Model.md § "Empty catch is non-conformant"
 *       + operations/Audit-Trail.md
 */
import type { SuppressedErrorEvent } from "../../errors/suppressed-event.js";

/**
 * A projection event emitted by an extension.
 * Type parameter `T` is the event payload shape.
 */
export interface ObservabilityEvent<T = unknown> {
  /** Machine-readable event type (e.g. `"ToolInvoked"`, `"SuppressedError"`). */
  readonly type: string;
  /** Structured payload specific to the event type. */
  readonly payload: T;
}

/** Projection event emission surface. */
export interface ObservabilityAPI {
  /**
   * Emit an arbitrary projection event.
   *
   * Core forwards the event to all active Logger extensions. The call does not
   * block: delivery is fire-and-forget.
   *
   * @param event - The event to emit.
   */
  emit<T = unknown>(event: ObservabilityEvent<T>): void;

  /**
   * Emit a `SuppressedError` event.
   *
   * This is the mandatory signal when an extension intentionally swallows an
   * error. An empty `catch {}` is non-conformant; use this method instead.
   *
   * @example
   * ```ts
   * try {
   *   await warmCache();
   * } catch (err) {
   *   host.observability.suppress({
   *     reason: 'intentional — cache warm is best-effort',
   *     cause: String(err),
   *     at: Date.now(),
   *   });
   * }
   * ```
   *
   * @param event - The suppressed-error payload (without the `type` discriminant,
   *   which the host fills in as `"SuppressedError"`).
   */
  suppress(event: Omit<SuppressedErrorEvent, "type">): void;
}
