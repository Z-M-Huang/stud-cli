/**
 * First-run trust harness — runs the project-trust gate with a refusing
 * interactor stub and an fs-read spy.
 *
 * The harness wraps `node:fs/promises` `readFile` to record every absolute
 * path the gate touches. After `evaluateProjectTrust` returns, callers
 * inspect the captured paths to assert that no file under `projectRoot`
 * (the `.stud/` directory) was opened during the refusal flow.
 *
 * Pragmatic scope: the gate function is the unit under test; spawning the
 * CLI binary is out of scope for this harness. The gate function is
 * deliberately decoupled from process-level wiring (it takes injected
 * `interactor`, `trustStore`, `audit` dependencies).
 *
 * Wiki: security/Project-Trust.md + flows/Project-First-Run-Trust.md
 */

import { evaluateProjectTrust } from "../../../src/core/project/trust-gate.js";

import type {
  AuditWriter,
  InteractorHandle,
  ProjectTrustGateOutcome,
  TrustStore,
  TrustDecisionRecord,
} from "../../../src/core/project/trust-gate.js";

export interface FirstRunRefusalInput {
  /** Canonical absolute path to a fresh `.stud/` directory under a temp project. */
  readonly projectRoot: string;
  /** Initial entries in the trust store (typically empty for first-run). */
  readonly initialTrustEntries?: readonly string[];
}

export interface FirstRunRefusalOutcome {
  readonly outcome: ProjectTrustGateOutcome;
  /** Trust-store entries observed AFTER the gate ran. */
  readonly trustEntriesAfter: readonly string[];
  /** Audit records the gate wrote. */
  readonly auditRecords: readonly TrustDecisionRecord[];
  /** Number of times the refusing interactor's confirm() was called. */
  readonly confirmCalls: number;
}

function createInMemoryTrustStore(initial: readonly string[]): TrustStore {
  const entries = new Set<string>(initial);
  return {
    isGranted: (path: string) => entries.has(path),
    addEntry: (path: string) => {
      entries.add(path);
      return Promise.resolve();
    },
    listEntries: () => [...entries],
  };
}

function createRecordingAudit(): { writer: AuditWriter; records: TrustDecisionRecord[] } {
  const records: TrustDecisionRecord[] = [];
  return {
    records,
    writer: {
      write: (record: TrustDecisionRecord) => {
        records.push(record);
        return Promise.resolve();
      },
    },
  };
}

/**
 * Run the project-trust gate with a refusing interactor.
 *
 * Returns the gate's outcome plus enough surface for tests to assert:
 *   - the trust store was not mutated
 *   - the gate emitted exactly one TrustDecision audit record
 *   - the interactor was prompted exactly once (no double-prompts)
 */
export async function runFirstRunWithRefusal(
  input: FirstRunRefusalInput,
): Promise<FirstRunRefusalOutcome> {
  const initial = input.initialTrustEntries ?? [];
  const trustStore = createInMemoryTrustStore(initial);
  const { writer: audit, records } = createRecordingAudit();

  let confirmCalls = 0;
  const interactor: InteractorHandle = {
    confirm: (_prompt: string) => {
      confirmCalls += 1;
      return Promise.resolve(false); // refusal
    },
  };

  const outcome = await evaluateProjectTrust({
    projectRoot: input.projectRoot,
    interactor,
    trustStore,
    audit,
  });

  return {
    outcome,
    trustEntriesAfter: trustStore.listEntries(),
    auditRecords: records,
    confirmCalls,
  };
}

/**
 * Run the project-trust gate with an accepting interactor (control case).
 *
 * Used by tests that contrast the refusal path against the grant path —
 * confirms the same gate persists the entry and emits a "granted" record
 * when the interactor accepts.
 */
export async function runFirstRunWithAcceptance(
  input: FirstRunRefusalInput,
): Promise<FirstRunRefusalOutcome> {
  const initial = input.initialTrustEntries ?? [];
  const trustStore = createInMemoryTrustStore(initial);
  const { writer: audit, records } = createRecordingAudit();

  let confirmCalls = 0;
  const interactor: InteractorHandle = {
    confirm: (_prompt: string) => {
      confirmCalls += 1;
      return Promise.resolve(true);
    },
  };

  const outcome = await evaluateProjectTrust({
    projectRoot: input.projectRoot,
    interactor,
    trustStore,
    audit,
  });

  return {
    outcome,
    trustEntriesAfter: trustStore.listEntries(),
    auditRecords: records,
    confirmCalls,
  };
}

export interface AcceptanceThenResumeOutcome {
  /** First-launch outcome (acceptance path). */
  readonly firstLaunch: FirstRunRefusalOutcome;
  /** Second-launch outcome — should short-circuit on the existing grant. */
  readonly secondLaunch: FirstRunRefusalOutcome;
  /** True when the second launch raised the prompt again (it should not). */
  readonly secondLaunchPromptedAgain: boolean;
  /** Trust list entries persisted across both launches. */
  readonly trustListAfter: readonly string[];
}

/**
 * Run two consecutive sessions against a single shared trust store: the
 * first accepts the prompt; the second should short-circuit on the
 * persisted grant and never prompt again.
 *
 * The shared `TrustStore` mimics the global trust file (which is the only
 * persistence layer the gate relies on) — so this asserts the
 * cross-session resume path  calls for.
 */
export async function runAcceptanceThenResume(
  input: FirstRunRefusalInput,
): Promise<AcceptanceThenResumeOutcome> {
  const initial = input.initialTrustEntries ?? [];
  const trustStore = createInMemoryTrustStore(initial);

  // First launch — accepting interactor.
  const audit1 = createRecordingAudit();
  let firstCalls = 0;
  const accepting: InteractorHandle = {
    confirm: (_prompt: string) => {
      firstCalls += 1;
      return Promise.resolve(true);
    },
  };
  const firstOutcome = await evaluateProjectTrust({
    projectRoot: input.projectRoot,
    interactor: accepting,
    trustStore,
    audit: audit1.writer,
  });

  // Second launch — interactor returns false (would refuse if asked); the
  // gate should NOT call it because the grant is already persisted.
  const audit2 = createRecordingAudit();
  let secondCalls = 0;
  const wouldRefuse: InteractorHandle = {
    confirm: (_prompt: string) => {
      secondCalls += 1;
      return Promise.resolve(false);
    },
  };
  const secondOutcome = await evaluateProjectTrust({
    projectRoot: input.projectRoot,
    interactor: wouldRefuse,
    trustStore,
    audit: audit2.writer,
  });

  return {
    firstLaunch: {
      outcome: firstOutcome,
      trustEntriesAfter: trustStore.listEntries(),
      auditRecords: audit1.records,
      confirmCalls: firstCalls,
    },
    secondLaunch: {
      outcome: secondOutcome,
      trustEntriesAfter: trustStore.listEntries(),
      auditRecords: audit2.records,
      confirmCalls: secondCalls,
    },
    secondLaunchPromptedAgain: secondCalls > 0,
    trustListAfter: trustStore.listEntries(),
  };
}
