import { Session } from "../../../../core/errors/index.js";

import type { InteractionResponse } from "../../../../contracts/ui.js";

export interface ActiveDialog {
  readonly kind: string;
  readonly requestId: string;
  readonly prompt: string;
}

export interface PendingInteraction {
  readonly resolve: (response: InteractionResponse) => void;
  readonly reject: (error: unknown) => void;
}

export interface InteractionDialogState {
  readonly dialogs: readonly ActiveDialog[];
  readonly answered: ReadonlySet<string>;
  readonly pending: ReadonlyMap<string, PendingInteraction>;
}

export function createInitialDialogState(answered?: ReadonlySet<string>): InteractionDialogState {
  return {
    dialogs: [],
    answered: answered ?? new Set<string>(),
    pending: new Map<string, PendingInteraction>(),
  };
}

export function raiseDialog(
  state: InteractionDialogState,
  request: ActiveDialog,
  pending?: PendingInteraction,
): InteractionDialogState {
  const nextPending = new Map(state.pending);
  if (pending !== undefined) {
    nextPending.set(request.requestId, pending);
  }
  return {
    ...state,
    dialogs: [...state.dialogs, request],
    pending: nextPending,
  };
}

export function dismissDialog(
  state: InteractionDialogState,
  requestId: string,
): InteractionDialogState {
  const nextPending = new Map(state.pending);
  nextPending.delete(requestId);
  return {
    ...state,
    dialogs: state.dialogs.filter((dialog) => dialog.requestId !== requestId),
    pending: nextPending,
  };
}

export function takePendingInteraction(
  state: InteractionDialogState,
  requestId: string,
): PendingInteraction | undefined {
  return state.pending.get(requestId);
}

export function respondToInteraction(
  state: InteractionDialogState,
  requestId: string,
  answer: unknown,
): Promise<{ readonly state: InteractionDialogState; readonly response: InteractionResponse }> {
  if (state.answered.has(requestId)) {
    throw new Session("interaction already answered", undefined, {
      code: "InteractionAlreadyAnswered",
      requestId,
    });
  }

  return Promise.resolve({
    state: {
      ...dismissDialog(state, requestId),
      answered: new Set([...state.answered, requestId]),
    },
    response: {
      correlationId: requestId,
      status: "accepted",
      value: answer,
    },
  });
}
