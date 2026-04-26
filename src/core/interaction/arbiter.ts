/**
 * Race-to-answer arbiter for multi-interactor sessions (Unit 58 — Q-9).
 *
 * When more than one interactor is attached concurrently, `createRaceArbiter`
 * fans out every `raise` call to ALL attached interactors simultaneously. The
 * first interactor to return an `accepted`, `rejected`, or `timeout` response
 * wins; the arbiter then:
 *
 *   1. Resolves the caller's promise with the winner's response.
 *   2. Emits an `InteractionAnswered` bus event carrying `winnerInteractorIndex`
 *      and `answeredAt`.
 *   3. Signals every losing interactor that it is dismissed by invoking the
 *      dismiss invoker registered for that interactor via `onDismiss`.
 *
 * Late responses surfaced via `reportLate` always reject with
 * `Session/InteractionAlreadyAnswered`.
 *
 * When exactly one interactor is provided the arbiter degenerates to the
 * single-interactor path: there are no losers and no dismiss calls are made.
 *
 * ## Dismiss mechanism
 *
 * For each interactor the arbiter creates a dismiss invoker function and
 * registers it via `interactor.onDismiss(dismissInvoker)`.  The invoker calls
 * the optional `dismiss(correlationId)` extension method (see
 * `DismissibleInteractor` below) when it is fired.  Storing the invoker and
 * firing it from the dismiss loop means the same path is used for both:
 *
 *   - **Arbiter-driven dismissal** — the arbiter invokes `dismissInvokers[i]`
 *     directly for every losing interactor after the race settles.
 *   - **User-driven dismissal** — the interactor fires the callback it received
 *     from `onDismiss` when the user closes its dialog.
 *
 * Interactors that omit `dismiss()` have their `request()` promises silently
 * abandoned when the invoker fires (acceptable v1 behaviour; the UI stays open
 * until the user acts).
 *
 * ## Error conditions
 *
 * - `Validation/NoInteractorsAttached` — thrown synchronously from
 *   `createRaceArbiter` when `interactors.length === 0`.
 * - `Session/InteractionAlreadyAnswered` — returned as a rejected Promise from
 *   `reportLate` whenever it is called.
 * - `Cancellation/TurnCancelled` propagates transparently; the arbiter cleans
 *   up its dismiss subscriptions on any rejection.
 *
 * Wiki: core/Interaction-Protocol.md (Q-9 multi-interactor extension)
 */

import { Session, Validation } from "../errors/index.js";

import type { InteractionAnsweredEvent } from "./dismissal-event.js";
import type { InteractionRequest, InteractionResponse, InteractorHandle } from "./protocol.js";
// Cancellation/TurnCancelled is not caught or transformed by the arbiter —
// it propagates transparently through Promise.race rejections to the caller.
// Imported explicitly here to document the dependency per the Contract Manifest.
import type { Cancellation as _Cancellation } from "../errors/index.js";
import type { EventBus } from "../events/bus.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArbiterInput {
  readonly interactors: readonly InteractorHandle[];
  readonly eventBus: EventBus;
  readonly clock: { now(): string };
}

export interface ArbiterHandle {
  raise(req: InteractionRequest): Promise<InteractionResponse>;
  pendingCount(): number;
}

// ---------------------------------------------------------------------------
// Internal dismiss extension
// ---------------------------------------------------------------------------

/**
 * Optional extension that interactor handles may implement to receive an
 * explicit dismiss signal from the arbiter when they lose a race.
 *
 * Interactors that do not implement `dismiss` have their `request()` promises
 * silently abandoned when another interactor wins (acceptable v1 behaviour).
 */
interface DismissibleInteractor extends InteractorHandle {
  readonly dismiss?: (correlationId: string) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a race-to-answer arbiter.
 *
 * The returned handle also exposes an internal `reportLate` method (not part
 * of `ArbiterHandle`) that UI implementations can call to learn about a lost
 * race. It always rejects with `Session/InteractionAlreadyAnswered`.
 */
export function createRaceArbiter(input: ArbiterInput): ArbiterHandle & {
  reportLate(resp: InteractionResponse): Promise<never>;
} {
  const { interactors, eventBus, clock } = input;

  if (interactors.length === 0) {
    throw new Validation("No interactors attached to the arbiter", undefined, {
      code: "NoInteractorsAttached",
    });
  }

  let pending = 0;

  // ---------------------------------------------------------------------------
  // raise
  // ---------------------------------------------------------------------------

  function raise(req: InteractionRequest): Promise<InteractionResponse> {
    pending++;

    // Create a dismiss invoker for each interactor and register it via
    // onDismiss. The invoker is the single dismiss path for BOTH directions:
    //   - Arbiter-driven: the arbiter calls dismissInvokers[i] for each loser.
    //   - User-driven:    the interactor fires the registered callback when
    //                     the user closes its dialog.
    const dismissInvokers: ((cid: string) => void)[] = [];
    const unsubs: (() => void)[] = [];

    for (const interactor of interactors as readonly DismissibleInteractor[]) {
      // Capture the interactor in the closure so the invoker calls the right one.
      const capturedInteractor = interactor;
      const dismissInvoker = (cid: string): void => {
        capturedInteractor.dismiss?.(cid);
      };
      dismissInvokers.push(dismissInvoker);
      unsubs.push(interactor.onDismiss(dismissInvoker));
    }

    function cleanup(): void {
      for (const unsub of unsubs) unsub();
    }

    // Fan out — race every interactor. Tag each result with its index so we
    // can identify the winner and dismiss the losers.
    const racePromises = (interactors as readonly DismissibleInteractor[]).map((interactor, idx) =>
      interactor.request(req).then((resp) => ({ resp, idx })),
    );

    return Promise.race(racePromises)
      .then(({ resp, idx: winnerIdx }) => {
        // Emit the InteractionAnswered bus event.
        const payload: InteractionAnsweredEvent["payload"] = {
          winnerInteractorIndex: winnerIdx,
          answeredAt: clock.now(),
        };
        eventBus.emit({
          name: "InteractionAnswered",
          correlationId: req.correlationId,
          monotonicTs: BigInt(Date.now()),
          payload,
        });

        // Invoke the registered onDismiss callback for every losing interactor.
        for (let i = 0; i < dismissInvokers.length; i++) {
          if (i !== winnerIdx) {
            dismissInvokers[i]!(req.correlationId);
          }
        }

        cleanup();
        pending--;
        return resp;
      })
      .catch((err: unknown) => {
        cleanup();
        pending--;
        throw err;
      });
  }

  // ---------------------------------------------------------------------------
  // reportLate
  // ---------------------------------------------------------------------------

  /**
   * Signal that a late response was submitted after another interactor already
   * won the race. Always rejects with `Session/InteractionAlreadyAnswered`.
   *
   * This method is intentionally not part of `ArbiterHandle` — only UI
   * implementations that explicitly surface late answers need it. Callers
   * access it via a type cast.
   */
  function reportLate(resp: InteractionResponse): Promise<never> {
    return Promise.reject(
      new Session("Interaction already answered", undefined, {
        code: "InteractionAlreadyAnswered",
        correlationId: resp.correlationId,
      }),
    );
  }

  return {
    raise,
    pendingCount(): number {
      return pending;
    },
    reportLate,
  };
}
