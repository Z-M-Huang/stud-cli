/**
 * InteractionAnsweredEvent — emitted by the race arbiter when a
 * multi-interactor interaction request is answered.
 *
 * Matches the `EventEnvelope` shape: `winnerInteractorIndex` and `answeredAt`
 * are nested under `payload`, alongside the standard envelope fields
 * (`name`, `correlationId`, `monotonicTs`).
 *
 * Losing interactors receive a dismiss signal before this event is emitted.
 *
 * Wiki: core/Interaction-Protocol.md (Q-9 multi-interactor extension)
 */

export interface InteractionAnsweredEvent {
  readonly name: "InteractionAnswered";
  readonly correlationId: string;
  readonly monotonicTs: bigint;
  readonly payload: {
    /** Zero-based index into the arbiter's `interactors` array of the winner. */
    readonly winnerInteractorIndex: number;
    /** Wall-clock timestamp from the arbiter's injected clock at answer time. */
    readonly answeredAt: string;
  };
}
