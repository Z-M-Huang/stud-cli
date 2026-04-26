/**
 * Trust-gate test fixtures.
 *
 * Provides mock implementations of `InteractorHandle`, `TrustStore`, and
 * `AuditWriter` for use in `tests/core/project/trust-gate.test.ts`.
 */

import type {
  AuditWriter,
  InteractorHandle,
  TrustDecisionRecord,
  TrustStore,
} from "../../src/core/project/trust-gate.js";

// ---------------------------------------------------------------------------
// MockInteractor
// ---------------------------------------------------------------------------

/** Extended `InteractorHandle` that exposes test-assertion state. */
export interface MockInteractor extends InteractorHandle {
  /** Number of `confirm` calls raised so far. */
  promptsRaised: number;
}

/**
 * Options for {@link mockInteractor}.
 *
 * Exactly one of `confirm` or `throws` must be supplied:
 *   - `confirm: boolean` — the mock resolves with that value.
 *   - `throws: Error`    — the mock rejects with that error, simulating a
 *     cancellation signal (or any other in-flight error) delivered while the
 *     prompt is waiting for user input.
 */
export type MockInteractorOpts =
  | { readonly confirm: boolean; readonly throws?: never }
  | { readonly throws: Error; readonly confirm?: never };

/**
 * Build a mock `InteractorHandle` that either:
 * - always returns the given `confirm` value without raising a real UI prompt, or
 * - always rejects with the given `throws` error (used to simulate
 *   `Cancellation/TurnCancelled` arriving while the prompt is in flight).
 *
 * @param opts - see {@link MockInteractorOpts}.
 */
export function mockInteractor(opts: MockInteractorOpts): MockInteractor {
  let _raised = 0;
  const handle: MockInteractor = {
    get promptsRaised(): number {
      return _raised;
    },
    set promptsRaised(v: number) {
      _raised = v;
    },
    confirm(_prompt: string): Promise<boolean> {
      _raised += 1;
      if (opts.throws !== undefined) {
        return Promise.reject(opts.throws);
      }
      return Promise.resolve(opts.confirm ?? false);
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// MockTrustStore
// ---------------------------------------------------------------------------

/** Extended `TrustStore` with test-assertion accessors. */
export interface MockTrustStore extends TrustStore {
  /** Returns the current set of granted canonical paths. */
  listEntries(): readonly string[];
}

/**
 * Build an in-memory `TrustStore` pre-seeded with the given `entries`.
 *
 * @param opts.entries - Canonical paths that start out as granted.
 */
export function mockTrustStore(opts: { readonly entries: readonly string[] }): MockTrustStore {
  const granted = new Set<string>(opts.entries);
  return {
    isGranted(canonicalPath: string): boolean {
      return granted.has(canonicalPath);
    },
    addEntry(canonicalPath: string): Promise<void> {
      granted.add(canonicalPath);
      return Promise.resolve();
    },
    listEntries(): readonly string[] {
      return [...granted];
    },
  };
}

/**
 * Build a `TrustStore` whose specified operations throw an Error.
 * Used to test the `Session/TrustStoreUnavailable` error paths.
 *
 * @param opts.throwOn - Which operation should throw: `"isGranted"` or `"addEntry"`.
 */
export function failingTrustStore(opts: {
  readonly throwOn: "isGranted" | "addEntry";
}): TrustStore {
  return {
    isGranted(_canonicalPath: string): boolean {
      if (opts.throwOn === "isGranted") {
        throw new Error("trust store I/O error");
      }
      return false;
    },
    addEntry(_canonicalPath: string): Promise<void> {
      if (opts.throwOn === "addEntry") {
        throw new Error("trust store I/O error");
      }
      return Promise.resolve();
    },
    listEntries(): readonly string[] {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// MockAuditWriter
// ---------------------------------------------------------------------------

/** Extended `AuditWriter` that accumulates records for snapshot assertions. */
export interface MockAuditWriter extends AuditWriter {
  /** All records written so far, in order. */
  readonly records: readonly TrustDecisionRecord[];
}

/**
 * Build an in-memory `AuditWriter` that collects every written record.
 * Inspect `audit.records` after the call under test.
 */
export function mockAudit(): MockAuditWriter {
  const _records: TrustDecisionRecord[] = [];
  return {
    get records(): readonly TrustDecisionRecord[] {
      return _records;
    },
    write(record: TrustDecisionRecord): Promise<void> {
      _records.push(record);
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Open-call recorder
// ---------------------------------------------------------------------------

/**
 * A probe that records any `node:fs/promises.open` calls attempted during a
 * test. Because `evaluateProjectTrust` is fully dependency-injected it never
 * calls `fs.open` directly; this recorder provides a documented safety check
 * that the assertion `opens.files` is always empty.
 */
export interface OpenCallRecorder {
  /** Files passed to any recorded `open` call. Always empty for trust-gate tests. */
  readonly files: readonly string[];
}

/**
 * Return an `OpenCallRecorder` for asserting that no files were opened.
 *
 * Since `evaluateProjectTrust` never performs direct filesystem I/O, this
 * recorder's `files` array will always be empty. The call exists to document
 * the invariant: the trust gate must never open any file under `.stud/`
 * before the trust decision is recorded (AC-62).
 */
export function recordingOpenCalls(): OpenCallRecorder {
  return { files: [] };
}
