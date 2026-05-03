/**
 * Output shape for the bundled `delegate` tool. Wiki:
 * reference-extensions/tools/Delegate-Tool.md §Output schema.
 *
 * Discriminated union over the three terminal child-session outcomes.
 * Mirrors `OpenChildResult` from `core/host/api/session.ts` for the
 * orchestrator's LLM-facing surface.
 */

export type DelegateResult =
  | {
      readonly result: string;
      readonly subagentId: string;
      readonly transcriptRef: string;
    }
  | {
      readonly haltStatus: {
        readonly requestKind: string;
        readonly correlationId: string;
        readonly subagentId: string;
        readonly decision: "halt";
        readonly reason: string;
      };
    }
  | {
      readonly aborted: {
        readonly reason:
          | "parentCancel"
          | "depthExceeded"
          | "envelopeDenied"
          | "envelopeInvalid"
          | "modelInvalid"
          | "modelCapabilityMismatch"
          | "crash"
          | "providerFailure";
        readonly subagentId: string;
      };
    };
