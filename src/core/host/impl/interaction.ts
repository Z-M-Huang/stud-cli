/**
 * HostInteractionImpl — per-extension Interaction-Protocol wrapper.
 *
 * `createHostInteraction` returns a frozen object whose `request` method
 * forwards to the session-level interaction arbiter with the calling
 * extension's `extId` so the arbiter can attribute and queue requests per
 * extension (Q-9 race-to-answer bookkeeping is handled in Unit 58).
 *
 * AC-56: the returned object is `Object.freeze`'d.
 *
 * Wiki: core/Interaction-Protocol.md + core/Host-API.md
 */

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * The concrete interaction wrapper given to one extension.
 *
 * `request` — forwards to the arbiter with the caller's `extId` for
 *             attribution and serialisation.
 */
export interface HostInteractionImpl {
  readonly request: (kind: string, spec: unknown) => Promise<{ accepted: boolean; data?: unknown }>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a per-extension interaction wrapper.
 *
 * @param deps.arbiter - Session-level interaction arbiter. Receives `kind`,
 *                       `spec`, and `extId`; returns a promise that resolves
 *                       to `{ accepted, data? }`.
 * @param deps.extId   - The owning extension's canonical ID, forwarded to the
 *                       arbiter for attribution and request ordering.
 */
export function createHostInteraction(deps: {
  arbiter: (
    kind: string,
    spec: unknown,
    extId: string,
  ) => Promise<{ accepted: boolean; data?: unknown }>;
  extId: string;
}): HostInteractionImpl {
  const { arbiter, extId } = deps;

  const impl: HostInteractionImpl = {
    request(kind: string, spec: unknown): Promise<{ accepted: boolean; data?: unknown }> {
      return arbiter(kind, spec, extId);
    },
  };

  return Object.freeze(impl);
}
