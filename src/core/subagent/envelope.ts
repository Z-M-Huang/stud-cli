/**
 * Subagent envelope validation.
 *
 * Strict-subset rule: every entry in `requestedEnvelope` must resolve to a
 * tool flat-name in the parent session's currently-active tool manifest at
 * the moment of the `delegate` call. Wiki:
 * core/Subagent-Sessions.md §Envelope §Construction and
 * reference-extensions/tools/Delegate-Tool.md §Validation order step 3.
 *
 * The validator runs as part of `openChild` AFTER the depth check (step 1)
 * and AFTER model resolution (step 2). All three rejections fire BEFORE any
 * IP request fires per the wiki's "no IP fires on validation failure" rule.
 */

import { ToolTerminal } from "../errors/index.js";

import type { SubagentEnvelope } from "../../contracts/subagent.js";

export interface ValidateEnvelopeInput {
  readonly requestedEnvelope: readonly string[] | undefined;
  readonly activeToolNames: readonly string[];
}

export type EnvelopeValidationResult =
  | { readonly ok: true; readonly envelope: SubagentEnvelope }
  | { readonly denied: ToolTerminal };

/**
 * Validate the requested envelope against the parent's active tool manifest.
 * Returns the canonicalized envelope on success (deduplicated, sorted) or a
 * typed rejection on failure. Empty envelopes are valid and result in every
 * subagent tool call falling through to the inherited mode gate.
 */
export function validateRequestedEnvelope(input: ValidateEnvelopeInput): EnvelopeValidationResult {
  const requested = input.requestedEnvelope ?? [];
  // Empty envelope is valid per Subagent-Sessions §Envelope §Construction.
  if (requested.length === 0) {
    return { ok: true, envelope: [] };
  }

  const activeSet = new Set(input.activeToolNames);
  const unknown: string[] = [];
  const seen = new Set<string>();
  const accepted: string[] = [];

  for (const name of requested) {
    if (typeof name !== "string" || name.length === 0) {
      unknown.push(String(name));
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    if (!activeSet.has(name)) {
      unknown.push(name);
      continue;
    }
    accepted.push(name);
  }

  if (unknown.length > 0) {
    return {
      denied: new ToolTerminal(
        `subagent envelope references unknown tool(s): ${unknown.join(", ")}`,
        undefined,
        {
          code: "Subagent/EnvelopeInvalid",
          unknown,
          requested,
        },
      ),
    };
  }

  // Sort for determinism — also matches the approval-key derivation
  // (`delegate:provider=...:model=...:depth=...:envelope=<sortedJoinedBy+>`)
  // per reference-extensions/tools/Delegate-Tool.md §Approval-key derivation.
  accepted.sort();
  return { ok: true, envelope: accepted };
}
