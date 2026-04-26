import type { ValidationFailure, ValidationOutcome } from "./validator.js";

interface OutcomeState {
  readonly populated: boolean;
  readonly outcomes: readonly ValidationOutcome[];
  readonly counts: { readonly warnings: number; readonly errors: number };
}

const outcomes: ValidationOutcome[] = [];
let populated = false;

export function registerOutcome(outcome: ValidationOutcome): void {
  populated = true;
  outcomes.push(outcome);
}

export function resetOutcomes(): void {
  populated = false;
  outcomes.length = 0;
}

export function getOutcomeState(): OutcomeState {
  return {
    populated,
    outcomes: outcomes.map(cloneOutcome),
    counts: countFailures(outcomes.flatMap((outcome) => outcome.failures)),
  };
}

function cloneOutcome(outcome: ValidationOutcome): ValidationOutcome {
  return {
    id: outcome.id,
    kind: outcome.kind,
    scope: outcome.scope,
    status: outcome.status,
    failures: outcome.failures.map(cloneFailure),
    ...(outcome.fallbackFrom !== undefined ? { fallbackFrom: outcome.fallbackFrom } : {}),
  };
}

function cloneFailure(failure: ValidationFailure): ValidationFailure {
  return {
    stage: failure.stage,
    severity: failure.severity,
    ...(failure.path !== undefined ? { path: failure.path } : {}),
    message: failure.message,
  };
}

function countFailures(failures: readonly ValidationFailure[]): {
  readonly warnings: number;
  readonly errors: number;
} {
  let warnings = 0;
  let errors = 0;

  for (const failure of failures) {
    if (failure.severity === "warning") {
      warnings += 1;
    } else {
      errors += 1;
    }
  }

  return { warnings, errors };
}
