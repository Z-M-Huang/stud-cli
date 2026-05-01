/**
 * SelectDialog manager — bridges Interaction-Protocol `select` requests on
 * the event bus to the Ink store's `selectDialog` state and back.
 *
 * Flow:
 *   1. `host.interaction.raise({ kind: "select", … })` (provider-host)
 *      emits `InteractionRaised` on the bus.
 *   2. This manager (subscribed via `subscribeRendererToBus`) opens the modal
 *      by setting `store.selectDialog`.
 *   3. The composer key handler calls `selectIndex` / `resolveCurrent` /
 *      `cancelCurrent` based on user keystrokes.
 *   4. Resolve emits `InteractionAnswered { status: "accepted", value }`;
 *      cancel emits `InteractionAnswered { status: "rejected" }`. The
 *      `host-interaction.ts` subscriber matches the `requestId` and resolves
 *      the original Promise.
 *
 * Mirrors `ink-approval.ts` / `ApprovalManager` for consistency.
 */
import type { EventBus } from "../../../../core/events/bus.js";
import type { InkStore } from "../ink-store.js";

export interface SelectManager {
  /** True when a `select` modal is currently visible. */
  hasActive(): boolean;
  /** Move the selection cursor without resolving. */
  selectIndex(index: number): void;
  /** Resolve the active modal with the option at the current `selectedIndex`. */
  resolveCurrent(): void;
  /** Cancel the active modal (Esc / Ctrl-C). */
  cancelCurrent(): void;
  /** Cancel everything in flight (used during `unmount()`). */
  cancelAll(): void;
  /** Unsubscribe from the bus so a remount doesn't accumulate dead listeners. */
  dispose(): void;
}

interface SelectRaisedPayload {
  readonly kind?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly prompt?: string;
  readonly options?: readonly string[];
}

function readPayload(env: { readonly payload: unknown }): SelectRaisedPayload | null {
  const p = env.payload;
  if (typeof p !== "object" || p === null) {
    return null;
  }
  return p as SelectRaisedPayload;
}

function deriveRequestId(payload: SelectRaisedPayload): string {
  return payload.requestId ?? payload.correlationId ?? "";
}

function pickMonotonic(): bigint {
  return process.hrtime.bigint();
}

function emitAnswered(
  bus: EventBus,
  requestId: string,
  status: "accepted" | "rejected",
  value: string | undefined,
): void {
  bus.emit({
    name: "InteractionAnswered",
    correlationId: requestId,
    monotonicTs: pickMonotonic(),
    payload: { requestId, correlationId: requestId, status, value },
  });
}

export function createSelectManager(args: {
  readonly bus: EventBus;
  readonly store: InkStore;
  readonly isUnmounted: () => boolean;
}): SelectManager {
  let activeRequestId: string | null = null;
  let activeOptions: readonly string[] = [];

  const unsubscribe = args.bus.on("InteractionRaised", (env) => {
    if (args.isUnmounted()) return;
    const payload = readPayload(env);
    if (payload?.kind !== "select") return;
    const requestId = deriveRequestId(payload);
    const options = payload.options;
    if (requestId.length === 0 || !Array.isArray(options) || options.length === 0) {
      return;
    }
    const safeOptions: readonly string[] = options.filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (safeOptions.length === 0) return;
    if (activeRequestId !== null) {
      // v1 policy: another modal already open — reject the newcomer immediately
      // so its Promise rejects with TurnCancelled instead of dangling.
      emitAnswered(args.bus, requestId, "rejected", undefined);
      return;
    }
    activeRequestId = requestId;
    activeOptions = safeOptions;
    args.store.setState((state) => ({
      ...state,
      selectDialog: {
        requestId,
        prompt: payload.prompt ?? "",
        options: activeOptions,
        selectedIndex: 0,
      },
    }));
  });

  const closeModal = (): void => {
    activeRequestId = null;
    activeOptions = [];
    args.store.setState((state) =>
      state.selectDialog === null ? state : { ...state, selectDialog: null },
    );
  };

  return {
    hasActive() {
      return activeRequestId !== null;
    },
    selectIndex(index) {
      args.store.setState((state) =>
        state.selectDialog === null
          ? state
          : {
              ...state,
              selectDialog: {
                ...state.selectDialog,
                selectedIndex: Math.max(0, Math.min(index, state.selectDialog.options.length - 1)),
              },
            },
      );
    },
    resolveCurrent() {
      const requestId = activeRequestId;
      if (requestId === null) return;
      const state = args.store.getState();
      const dialog = state.selectDialog;
      if (dialog === null) {
        closeModal();
        return;
      }
      const value = dialog.options[dialog.selectedIndex];
      closeModal();
      emitAnswered(args.bus, requestId, "accepted", value);
    },
    cancelCurrent() {
      const requestId = activeRequestId;
      if (requestId === null) return;
      closeModal();
      emitAnswered(args.bus, requestId, "rejected", undefined);
    },
    cancelAll() {
      const requestId = activeRequestId;
      if (requestId === null) return;
      closeModal();
      emitAnswered(args.bus, requestId, "rejected", undefined);
    },
    dispose() {
      unsubscribe();
    },
  };
}
