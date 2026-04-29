/**
 * Approval-queue manager for the Ink mount.
 *
 * Owns the in-flight approval queue, drives the dialog state in the store,
 * and exposes the verbs the composer keyboard handler / lifecycle calls.
 */
import type { ApprovalDecision, ApprovalDialogView } from "./approval-dialog.js";
import type { InkStore } from "./ink-store.js";
import type { ToolApprovalRequest } from "./mount.js";

interface PendingApprovalRequest {
  readonly request: ToolApprovalRequest;
  readonly resolve: (decision: ApprovalDecision) => void;
}

export interface ApprovalManager {
  /** Queue an approval request and pump if no other approval is open. */
  enqueue(request: ToolApprovalRequest): Promise<ApprovalDecision>;
  /** Move the dialog cursor without resolving. */
  selectIndex(selectedIndex: number): void;
  /** Resolve the active approval with the given decision. */
  resolve(decision: ApprovalDecision): void;
  /** Tear-down: deny everything in flight and queued. */
  denyAll(): void;
  /** True when a dialog is currently being shown to the user. */
  hasActive(): boolean;
}

export function createApprovalManager(args: {
  readonly store: InkStore;
  /**
   * When set, `enqueue` resolves to "deny" immediately without touching the
   * store. Used during/after `unmount`.
   */
  readonly isUnmounted: () => boolean;
}): ApprovalManager {
  const queue: PendingApprovalRequest[] = [];
  let active: PendingApprovalRequest | null = null;

  const showDialog = (pending: PendingApprovalRequest): void => {
    active = pending;
    args.store.setState((state) => ({
      ...state,
      palette: null,
      paletteSelectedIndex: 0,
      approvalDialog: dialogView(pending),
    }));
  };

  const pump = (): void => {
    if (active !== null) return;
    const next = queue.shift();
    if (next !== undefined) {
      showDialog(next);
    }
  };

  return {
    enqueue(request) {
      if (args.isUnmounted()) {
        return Promise.resolve("deny");
      }
      return new Promise<ApprovalDecision>((resolve) => {
        queue.push({ request, resolve });
        pump();
      });
    },
    selectIndex(selectedIndex) {
      args.store.setState((state) =>
        state.approvalDialog === null
          ? state
          : {
              ...state,
              approvalDialog: { ...state.approvalDialog, selectedIndex },
            },
      );
    },
    resolve(decision) {
      const current = active;
      if (current === null) return;
      active = null;
      args.store.setState((state) => ({ ...state, approvalDialog: null }));
      current.resolve(decision);
      pump();
    },
    denyAll() {
      const current = active;
      active = null;
      args.store.setState((state) => ({ ...state, approvalDialog: null }));
      current?.resolve("deny");
      while (queue.length > 0) {
        queue.shift()?.resolve("deny");
      }
    },
    hasActive() {
      return active !== null;
    },
  };
}

function dialogView(pending: PendingApprovalRequest): ApprovalDialogView {
  return {
    toolId: pending.request.toolId,
    approvalKey: pending.request.displayApprovalKey,
    selectedIndex: 0,
  };
}
