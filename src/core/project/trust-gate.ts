/**
 * Project-trust first-run gate.
 *
 * Evaluates whether the user has granted trust to the project at `projectRoot`
 * (always exactly `<cwd>/.stud/` — invariant #5). On first entry it prompts
 * once via the Interaction Protocol, persists the decision in the global trust
 * list, and emits an auditable `TrustDecision` record.
 *
 * Pre-conditions enforced:
 *   - `projectRoot` must be a canonicalized absolute path ending in `.stud`.
 *   - No file under `projectRoot` is read or executed before this function
 *     returns — callers MUST NOT read any `.stud/` content first.
 *
 * Wiki: security/Trust-Model.md + security/Project-Trust.md
 *       + flows/Project-First-Run-Trust.md
 *
 * ---
 *
 * AC-61 scope note:
 *   AC-61 requires three independent gates to run in order on project entry:
 *   project-trust, extension-integrity, and MCP-trust. This unit implements
 *   the project-trust gate and satisfies AC-61's audit-record interface: each
 *   evaluation emits a structured `TrustDecision` record that the orchestrator
 *   can chain in order with the other two gates. The orchestration of all three
 *   gates in sequence is deferred to the unit that wires the project-entry
 *   flow (the unit introducing the project-entry orchestrator).
 *
 * Path note:
 *   AC-61 mentions `src/core/security/trust/` as the target directory. The
 *   Contract Manifest for this unit (the authoritative design artefact) places
 *   the gate at `src/core/project/trust-gate.ts` because the project-trust
 *   concern belongs with the other project-root utilities (root resolution,
 *   discovery) rather than inside the security sub-tree, which is reserved for
 *   cross-cutting security policies. If the wiki is updated to reflect this
 *   canonical location, AC-61 should be updated accordingly.
 */

import { basename, isAbsolute, normalize } from "node:path";

// Imports from the barrel re-export (src/core/errors/index.ts), which
// re-exports Session from ./session.ts and Validation from ./validation.ts.
// Using the barrel keeps the import surface stable if individual files move.
import { Session, Validation } from "../errors/index.js";

// ---------------------------------------------------------------------------
// Dependency interfaces — wired through types only until Unit 51 / Unit 57
// ---------------------------------------------------------------------------

/**
 * Minimal surface the trust gate needs to raise a yes/no prompt.
 *
 * The full Interaction Protocol (Unit 57) satisfies this interface — the
 * gate does not depend on the complete shape.
 */
export interface InteractorHandle {
  /**
   * Raise a yes/no confirmation prompt.
   *
   * Returns `true` when the user accepts, `false` when the user declines.
   * Throws `Cancellation/TurnCancelled` when the user cancels the session.
   */
  confirm(prompt: string): Promise<boolean>;
}

/**
 * Persistent store of project-trust decisions keyed by canonical path.
 *
 * The concrete implementation (Unit 51) reads and writes the global trust
 * file (`~/.stud/trust.json` or equivalent). This interface decouples the
 * gate from the store's I/O format.
 */
export interface TrustStore {
  /** Returns `true` when the canonical path has a previously recorded grant. */
  isGranted(canonicalPath: string): boolean;
  /**
   * Persist a new trust grant for the given canonical path.
   *
   * Throws `Session/TrustStoreUnavailable` when the store cannot be written.
   */
  addEntry(canonicalPath: string): Promise<void>;
  /** Returns all canonical paths that have been granted trust. */
  listEntries(): readonly string[];
}

/**
 * A structured trust-decision record written to the audit trail.
 *
 * Invariant #6: must never contain resolved secret material — only the
 * canonical path and the decision outcome.
 *
 * Wiki: operations/Audit-Trail.md
 */
export interface TrustDecisionRecord {
  /** Canonical absolute path to the `.stud` directory. */
  readonly canonicalPath: string;
  /** The user's trust decision for this path. */
  readonly decision: "granted" | "refused";
  /** ISO-8601 timestamp of the decision. */
  readonly at: string;
}

/**
 * Minimal write surface for recording trust decisions.
 *
 * The full `AuditAPI` (Unit 57) satisfies this interface. The narrowed type
 * keeps the gate decoupled from the complete host API shape.
 */
export interface AuditWriter {
  write(record: TrustDecisionRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Public gate types
// ---------------------------------------------------------------------------

export interface ProjectTrustGateInput {
  /** Canonical absolute path to `<cwd>/.stud/`. Must satisfy invariant #5. */
  readonly projectRoot: string;
  /** Prompts via the Interaction Protocol. */
  readonly interactor: InteractorHandle;
  /** Reads/writes the global trust list. */
  readonly trustStore: TrustStore;
  readonly audit: AuditWriter;
}

export interface ProjectTrustGateOutcome {
  readonly kind: "granted" | "refused";
  readonly canonicalPath: string;
  /** ISO-8601; present only on `"granted"`. */
  readonly grantedAt?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `path` is a canonicalized absolute path ending in
 * `.stud` (the only valid shape for a project root — invariant #5).
 *
 * A path is considered non-canonical when `normalize(path) !== path` (e.g.
 * it contains `..` segments or duplicate separators).
 */
function isValidProjectRoot(path: string): boolean {
  return isAbsolute(path) && normalize(path) === path && basename(path) === ".stud";
}

// ---------------------------------------------------------------------------
// Gate function
// ---------------------------------------------------------------------------

/**
 * Evaluate whether the user has granted trust to the project at `projectRoot`.
 *
 * Execution model:
 *   1. Validate `projectRoot` shape — throws `Validation/ProjectPathInvalid`
 *      immediately if non-canonical or not ending in `.stud`.
 *   2. Query the trust store — if trust is already recorded, emit a
 *      `TrustDecision{decision: "granted"}` audit record and return `"granted"`
 *      without prompting (short-circuit). AC-61 requires "each evaluation"
 *      to produce an audit record, including pre-existing grants.
 *   3. Raise one `confirm` prompt via the interactor.
 *   4a. Refusal — emit `TrustDecision{decision: "refused"}` audit record,
 *       return `{kind: "refused"}`. No mutation to the trust store; no file
 *       under `projectRoot` is opened.
 *   4b. Grant — persist to the trust store, emit
 *       `TrustDecision{decision: "granted"}` audit record, return
 *       `{kind: "granted", grantedAt}`.
 *
 * @throws Validation/ProjectPathInvalid — `projectRoot` is not canonical.
 * @throws Session/TrustStoreUnavailable — store read or write failed.
 * @throws Cancellation/TurnCancelled — user cancelled during the prompt.
 */
export async function evaluateProjectTrust(
  input: ProjectTrustGateInput,
): Promise<ProjectTrustGateOutcome> {
  const { projectRoot, interactor, trustStore, audit } = input;

  // Step 1 — validate path shape
  if (!isValidProjectRoot(projectRoot)) {
    throw new Validation(
      "projectRoot must be a canonicalized absolute path ending in .stud",
      undefined,
      { code: "ProjectPathInvalid", projectRoot },
    );
  }

  // Step 2 — short-circuit on pre-existing grant
  let alreadyGranted: boolean;
  try {
    alreadyGranted = trustStore.isGranted(projectRoot);
  } catch (err) {
    throw new Session("trust store unavailable during grant check", err, {
      code: "TrustStoreUnavailable",
    });
  }

  if (alreadyGranted) {
    const now = new Date().toISOString();
    await audit.write({ canonicalPath: projectRoot, decision: "granted", at: now });
    return { kind: "granted", canonicalPath: projectRoot };
  }

  // Step 3 — prompt the user (at most once per call)
  const confirmed = await interactor.confirm(
    `Trust project at '${projectRoot}'? Extensions and configuration under this directory will be loaded.`,
  );

  const now = new Date().toISOString();

  // Step 4a — refusal path
  if (!confirmed) {
    await audit.write({ canonicalPath: projectRoot, decision: "refused", at: now });
    return { kind: "refused", canonicalPath: projectRoot };
  }

  // Step 4b — grant path
  try {
    await trustStore.addEntry(projectRoot);
  } catch (err) {
    throw new Session("trust store unavailable while recording grant", err, {
      code: "TrustStoreUnavailable",
    });
  }

  await audit.write({ canonicalPath: projectRoot, decision: "granted", at: now });
  return { kind: "granted", canonicalPath: projectRoot, grantedAt: now };
}
