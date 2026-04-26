/**
 * EventsAPI — the projection-only event bus surface exposed to extensions.
 *
 * Extensions may subscribe to named events emitted by core and other extensions,
 * and may emit their own projection events. This surface is observer-only:
 * extensions cannot intercept or cancel core events through this API —
 * that authority belongs exclusively to guard hooks (Hook contract).
 *
 * Wiki: core/Event-and-Command-Ordering.md + core/Host-API.md
 */

/** Handler function for a named event. */
export type EventHandler<T = unknown> = (payload: T) => void;

/** Projection-only event bus surface. */
export interface EventsAPI {
  /**
   * Subscribe to a named event.
   * Multiple handlers for the same event name are called in registration order.
   *
   * @param event   - Event name (case-sensitive string token).
   * @param handler - Callback invoked with the event payload.
   */
  on<T = unknown>(event: string, handler: EventHandler<T>): void;

  /**
   * Remove a previously registered handler.
   * A no-op if the handler was never registered or has already been removed.
   *
   * @param event   - Event name.
   * @param handler - The same function reference passed to `on`.
   */
  off<T = unknown>(event: string, handler: EventHandler<T>): void;

  /**
   * Emit a named event to all registered handlers.
   * Extensions may emit their own events; they must not emit core-reserved
   * event names (those are controlled by the core lifecycle manager).
   *
   * @param event   - Event name.
   * @param payload - Arbitrary payload delivered to each handler.
   */
  emit<T = unknown>(event: string, payload: T): void;
}
