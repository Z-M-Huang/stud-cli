import { Validation } from "../errors/index.js";

import { scanForLeaks } from "./isolation-guard.js";

import type { AssembledRequest } from "./assembler.js";
import type { IsolationInput } from "./isolation-guard.js";

export function enforceIsolation(input: IsolationInput): AssembledRequest {
  const verdict = scanForLeaks(input);
  if (verdict.clean) {
    return input.assembled;
  }

  for (const violation of verdict.violations) {
    void input.audit.write({
      class: "IsolationViolation",
      ...violation,
    });
  }

  throw new Validation("LLM context isolation violation detected", undefined, {
    code: "LLMContextLeak",
    violations: verdict.violations,
  });
}
