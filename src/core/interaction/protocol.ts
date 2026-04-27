/**
 * Interaction Protocol core — single-interactor FIFO serializer.
 *
 * `createInteractionProtocol` is the session-level entry point for every
 * authority (SM, mode gate, tool, provider auth) that needs to present a
 * prompt to the active UI interactor.
 *
 * ## FIFO guarantee
 *
 * Prompts are serialized strictly in arrival order. A second `raise` call does
 * not invoke the interactor until the first call's promise has settled. This
 * prevents concurrent approval prompts from confusing the user and removes any
 * race between parallel tool calls that both need approval.
 *
 * ## This unit — single-interactor path
 *
 * Exactly one interactor is assumed.  extends this to the multi-interactor
 * race-to-answer arbiter; the `InteractorHandle[]` array is already present in the
 * deps interface so the upgrade is additive.
 *
 * ## Event emissions
 *
 * - `InteractionRaised`  — emitted synchronously before the interactor is called.
 * - `InteractionAnswered` — emitted after the interactor resolves.
 *
 * ## Audit records
 *
 * The protocol does NOT write audit records. The authority that requested the
 * prompt (SM, mode gate, tool, provider auth) is responsible for writing its own
 * audit record after inspecting the returned `InteractionResponse`. This keeps
 * the protocol free of an `auditWriter` dependency and lets each authority encode
 * the correct audit class and context for its specific use case.
 *
 * ## Error conditions
 *
 * - `Validation/InteractionKindUnknown`       — unknown `kind` on the request.
 * - `Validation/InteractionPayloadMismatch`   — `kind` and `payload.kind` disagree.
 * - `Session/NoInteractorAttached`            — `interactors` array is empty.
 * - `Cancellation/TurnCancelled`              — interactor signals dismiss during a pending prompt.
 *
 * Wiki: core/Interaction-Protocol.md
 */

import { Cancellation, Session, Validation } from "../errors/index.js";

import { INTERACTION_REQUEST_KINDS } from "./request-kinds.js";

import type { InteractionPayload, InteractionRequestKind } from "./request-kinds.js";
import type { EventBus } from "../events/bus.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InteractionRequest {
  readonly kind: InteractionRequestKind;
  readonly correlationId: string;
  /** ISO-8601 wall-clock timestamp assigned by the caller. */
  readonly issuedAt: string;
  /** Must have `payload.kind === req.kind`; enforced at protocol boundary. */
  readonly payload: InteractionPayload;
}

export type InteractionResponse =
  | { kind: "accepted"; correlationId: string; value: unknown }
  | { kind: "rejected"; correlationId: string; reason: string }
  | { kind: "timeout"; correlationId: string };

export interface InteractorHandle {
  request(req: InteractionRequest): Promise<InteractionResponse>;
  onDismiss(cb: (correlationId: string) => void): () => void;
}

export interface InteractionProtocolCore {
  raise(req: InteractionRequest): Promise<InteractionResponse>;
  pendingCount(): number;
}

export interface InteractionProtocolDeps {
  /** Active interactors. exactly one. + allows the arbiter. */
  readonly interactors: readonly InteractorHandle[];
  readonly eventBus: EventBus;
  readonly clock: { now(): string };
  /**
   * Reserved for 's multi-interactor race-to-answer arbiter, which will
   * generate fresh correlation IDs when fanning out to multiple interactors.
   *  (single-interactor path) does not call this; callers must still
   * supply it so that the interface is forward-compatible without a breaking
   * change when  lands.
   */
  readonly newCorrelationId: () => string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface QueueEntry {
  req: InteractionRequest;
  resolve: (r: InteractionResponse) => void;
  reject: (e: unknown) => void;
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

function validateRequest(
  req: InteractionRequest,
  interactors: readonly InteractorHandle[],
): Validation | Session | null {
  if (!INTERACTION_REQUEST_KINDS.includes(req.kind)) {
    return new Validation(`Unknown interaction kind: ${req.kind}`, undefined, {
      code: "InteractionKindUnknown",
      kind: req.kind,
    });
  }
  if (req.payload.kind !== req.kind) {
    return new Validation(
      `Payload kind '${req.payload.kind}' does not match request kind '${req.kind}'`,
      undefined,
      { code: "InteractionPayloadMismatch", requestKind: req.kind, payloadKind: req.payload.kind },
    );
  }
  if (interactors.length === 0) {
    return new Session("No interactor attached to the current session", undefined, {
      code: "NoInteractorAttached",
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a session-level interaction protocol instance.
 *
 * The returned core serializes all `raise` calls FIFO: a second call does not
 * invoke the interactor until the first has settled. This is achieved by
 * maintaining a `queue` and an `isRunning` flag rather than a promise chain so
 * that the first request's interactor call happens synchronously (before the
 * first `await`) and test code can assert ordering without extra ticks.
 */
export function createInteractionProtocol(deps: InteractionProtocolDeps): InteractionProtocolCore {
  const { interactors, eventBus } = deps;
  const queue: QueueEntry[] = [];
  let isRunning = false;
  let pending = 0;

  async function processNext(): Promise<void> {
    if (isRunning || queue.length === 0) return;
    isRunning = true;
    const entry = queue.shift()!;

    // Extract the dismiss-promise reject function so the cleanup subscription
    // can be registered outside the Promise constructor (avoids TypeScript
    // control-flow narrowing issues with let-variables assigned in callbacks).
    let rejectOnDismiss: ((err: unknown) => void) | null = null;
    const dismissPromise = new Promise<never>((_resolve, reject) => {
      rejectOnDismiss = reject;
    });

    const dismissCleanup = interactors[0]!.onDismiss((cid) => {
      if (cid === entry.req.correlationId) {
        rejectOnDismiss!(
          new Cancellation("prompt dismissed", undefined, {
            code: "TurnCancelled",
            correlationId: cid,
          }),
        );
      }
    });

    try {
      eventBus.emit({
        name: "InteractionRaised",
        correlationId: entry.req.correlationId,
        monotonicTs: BigInt(Date.now()),
        payload: { kind: entry.req.kind, correlationId: entry.req.correlationId },
      });

      // Race the interactor response against the dismiss signal.
      const requestPromise = interactors[0]!.request(entry.req);
      const response = await Promise.race([requestPromise, dismissPromise]);

      eventBus.emit({
        name: "InteractionAnswered",
        correlationId: entry.req.correlationId,
        monotonicTs: BigInt(Date.now()),
        payload: {
          kind: entry.req.kind,
          correlationId: entry.req.correlationId,
          responseKind: response.kind,
        },
      });
      entry.resolve(response);
    } catch (err) {
      entry.reject(err);
    } finally {
      dismissCleanup();
      isRunning = false;
      pending--;
      void processNext();
    }
  }

  function raise(req: InteractionRequest): Promise<InteractionResponse> {
    const validationErr = validateRequest(req, interactors);
    if (validationErr !== null) return Promise.reject(validationErr);
    pending++;
    const p = new Promise<InteractionResponse>((resolve, reject) => {
      queue.push({ req, resolve, reject });
    });
    void processNext();
    return p;
  }

  return {
    raise,
    pendingCount(): number {
      return pending;
    },
  };
}
