/**
 * Approval-gate test fixtures.
 *
 * Provides `memoryCache()` and `stubInteractor()` for use in
 * `tests/core/security/modes/gate.test.ts`.
 *
 * Neither helper performs any I/O. Both are deterministic and safe to
 * instantiate in any number of parallel test cases.
 */

import type {
  ApprovalCacheReadWrite,
  InteractorHandle,
} from "../../src/core/security/modes/gate.js";

// ---------------------------------------------------------------------------
// StubInteractor
// ---------------------------------------------------------------------------

/** Extended `InteractorHandle` with test-assertion state. */
export interface StubInteractor extends InteractorHandle {
  /** Total number of `approve` calls made so far. */
  readonly approvePromptCount: number;
}

/** Options for {@link stubInteractor}. */
export interface StubInteractorOpts {
  /** The boolean the stub resolves every `approve()` call with. */
  readonly approvalAnswer: boolean;
}

/**
 * Build a `InteractorHandle` stub that always resolves `approve()` with the
 * given `approvalAnswer` value, never opening any real UI prompt.
 *
 * Inspect `stub.approvePromptCount` to assert how many times the interactor
 * was consulted.
 */
export function stubInteractor(opts: StubInteractorOpts): StubInteractor {
  let _count = 0;

  return {
    get approvePromptCount(): number {
      return _count;
    },
    approve(_prompt: string): Promise<boolean> {
      _count += 1;
      return Promise.resolve(opts.approvalAnswer);
    },
  };
}

// ---------------------------------------------------------------------------
// memoryCache
// ---------------------------------------------------------------------------

/**
 * Build an in-memory `ApprovalCacheReadWrite` backed by a `Map`.
 *
 * Each call returns an independent cache instance so test cases do not share
 * state.
 */
export function memoryCache(): ApprovalCacheReadWrite {
  const store = new Map<string, true>();

  function cacheKey(toolId: string, approvalKey: string): string {
    return `${toolId}\x00${approvalKey}`;
  }

  return {
    has(toolId: string, approvalKey: string): boolean {
      return store.has(cacheKey(toolId, approvalKey));
    },
    set(toolId: string, approvalKey: string): void {
      store.set(cacheKey(toolId, approvalKey), true);
    },
  };
}
