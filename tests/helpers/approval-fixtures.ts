/**
 * Approval-gate test fixtures.
 *
 * Provides `memoryCache()` and `stubRaiseApproval()` for use in gate.test.ts
 * and stack.test.ts.
 *
 * Neither helper performs any I/O. Both are deterministic and safe to
 * instantiate in any number of parallel test cases.
 */

import type {
  ApprovalCacheReadWrite,
  RaiseApproval,
  RaiseApprovalOutcome,
} from "../../src/core/security/modes/gate.js";

// ---------------------------------------------------------------------------
// stubRaiseApproval
// ---------------------------------------------------------------------------

export interface StubRaiseApproval {
  /** Total number of times the callback was invoked. */
  readonly callCount: number;
  /** Inputs captured per call (toolId + approvalKey). */
  readonly calls: readonly { readonly toolId: string; readonly approvalKey: string }[];
  /** The callback to inject as `raiseApproval`. */
  readonly raiseApproval: RaiseApproval;
}

export interface StubRaiseApprovalOpts {
  /**
   * Outcome the stub returns for every call. Defaults to `{ kind: "approve" }`.
   * Use `{ kind: "halt", reason }` to simulate the headless emit-and-halt
   * fallthrough; use `{ kind: "deny" }` to simulate user rejection.
   */
  readonly outcome?: RaiseApprovalOutcome;
}

/**
 * Build a `raiseApproval` callback stub that resolves every call with the
 * configured outcome. Inspect `stub.callCount` and `stub.calls` to assert
 * how many times the callback was consulted and with what arguments.
 */
export function stubRaiseApproval(opts: StubRaiseApprovalOpts = {}): StubRaiseApproval {
  const outcome: RaiseApprovalOutcome = opts.outcome ?? { kind: "approve" };
  const calls: { readonly toolId: string; readonly approvalKey: string }[] = [];

  const raiseApproval: RaiseApproval = (input) => {
    calls.push({ toolId: input.toolId, approvalKey: input.approvalKey });
    return Promise.resolve(outcome);
  };

  return {
    get callCount(): number {
      return calls.length;
    },
    get calls(): readonly { readonly toolId: string; readonly approvalKey: string }[] {
      return calls;
    },
    raiseApproval,
  };
}

/**
 * `raiseApproval` stub that fails the test if invoked. Useful when a test
 * asserts the gate took a path (yolo, allowlist match, cache hit) that
 * should never reach the Interaction Protocol callback.
 */
export const raiseApprovalUnreachable: RaiseApproval = () => {
  throw new Error("raiseApproval was invoked but the test asserted it should not be");
};

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

/**
 * Build a memory cache plus an external mirror set so tests can assert
 * exactly which `(toolId, approvalKey)` pairs were written. Returns the
 * cache itself plus a `writes` array that grows with each `cache.set` call.
 */
export function memoryCacheWithWriteLog(): {
  readonly cache: ApprovalCacheReadWrite;
  readonly writes: readonly { readonly toolId: string; readonly approvalKey: string }[];
} {
  const inner = memoryCache();
  const writes: { readonly toolId: string; readonly approvalKey: string }[] = [];

  return {
    cache: {
      has(toolId, approvalKey): boolean {
        return inner.has(toolId, approvalKey);
      },
      set(toolId, approvalKey): void {
        writes.push({ toolId, approvalKey });
        inner.set(toolId, approvalKey);
      },
    },
    get writes() {
      return writes;
    },
  };
}
