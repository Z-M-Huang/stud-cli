import type { ProviderSelection } from "./types.js";

/**
 * Mid-session swap holder for the active provider selection.
 *
 * The session loop reads `current()` to dispatch each turn's request. The
 * `/provider` and `/model` commands call `swap()` after capability negotiation
 * to publish a new selection; the holder bumps `revisionId()` and notifies
 * subscribers (metrics, TUI header). `revisionId()` is monotonic — a rejected
 * swap leaves it unchanged so observers can detect missed updates.
 *
 * Wiki: flows/Hot-Model-Switch.md (revisionId), flows/Capability-Mismatch-Switch.md.
 */
export interface ActiveSelectionHolder {
  current(): ProviderSelection;
  revisionId(): number;
  swap(next: ProviderSelection): void;
  onChange(handler: (selection: ProviderSelection) => void): () => void;
}

export function createActiveSelectionHolder(initial: ProviderSelection): ActiveSelectionHolder {
  let selection = initial;
  let revision = 0;
  const listeners = new Set<(selection: ProviderSelection) => void>();

  return {
    current() {
      return selection;
    },
    revisionId() {
      return revision;
    },
    swap(next) {
      selection = next;
      revision += 1;
      for (const listener of listeners) {
        listener(selection);
      }
    },
    onChange(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
