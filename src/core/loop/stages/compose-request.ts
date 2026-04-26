/**
 * COMPOSE_REQUEST stage handler.
 *
 * Responsibilities (wiki: core/Message-Loop.md §COMPOSE_REQUEST):
 *   1. Validate that an assembler has been wired (startup misconfiguration guard).
 *   2. Delegate all real composition work to the injected assembler.
 *   3. Forward the composed request to SEND_REQUEST.
 *
 * Full context assembly (system prompt + history + tool defs + provider
 * contributions + compaction) is intentionally out of scope here; that work
 * belongs to Units 65-68 (context/ directory). This unit exposes the seam —
 * the `ComposeRequestAssembler` injection point — so the message loop is
 * complete and testable before those units land.
 *
 * Errors thrown:
 *   ExtensionHost / AssemblerUnavailable — no assembler was wired at startup.
 *   Validation / ContextOverflow — passed through from the assembler (compacted
 *     request still exceeds the model window).
 *   Validation / ContextProviderFailed — passed through from the assembler (a
 *     non-graceful Context Provider failed).
 *
 * Side effects: None. All reads are performed inside the assembler closure.
 * All writes belong to downstream stages.
 *
 * Wiki: core/Message-Loop.md + context/Context-Assembly.md
 */

import { ExtensionHost } from "../../errors/index.js";

import type { StageHandler } from "../orchestrator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ComposeRequestPayload {
  readonly prior: {
    readonly kind: "message" | "tool-results";
    readonly content: unknown;
  };
  readonly iteration: number;
}

export interface ComposedRequest {
  readonly systemPrompt: string;
  readonly messages: readonly {
    role: "user" | "assistant" | "tool";
    content: unknown;
  }[];
  readonly toolManifest: readonly { id: string; schema: unknown }[];
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * Injected by the Context Assembly orchestrator (Unit 65). Accepts the current
 * turn's prior payload and returns a fully composed request ready for the
 * provider wire-call.
 */
export type ComposeRequestAssembler = (input: ComposeRequestPayload) => Promise<ComposedRequest>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function composeRequestStage(deps: {
  readonly assembler: ComposeRequestAssembler;
}): StageHandler<ComposeRequestPayload, { composed: ComposedRequest }> {
  return async function composeRequest(input) {
    if (deps.assembler == null) {
      throw new ExtensionHost(
        "COMPOSE_REQUEST: no assembler wired — startup misconfiguration",
        undefined,
        { code: "AssemblerUnavailable" },
      );
    }

    // Delegate — typed errors (ContextOverflow, ContextProviderFailed) from the
    // assembler propagate to the caller unchanged.
    const composed = await deps.assembler(input.payload);

    return {
      next: "SEND_REQUEST",
      payload: { composed },
    };
  };
}
