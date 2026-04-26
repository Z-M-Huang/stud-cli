export const AUDIT_CLASSES = [
  "Approval",
  "Compaction",
  "StageExecution",
  "ModelSwitch",
  "ProviderSwitch",
  "ExtensionSetRevision",
  "TrustDecision",
  "SMTransition",
  "Integrity",
  "SessionLifecycle",
  "SuppressedError",
] as const;

export type AuditClass = (typeof AUDIT_CLASSES)[number];

export interface AuditPayloads {
  readonly Approval: { readonly decision: "approved" | "denied"; readonly toolId: string };
  readonly Compaction: {
    readonly droppedMessages: number;
    readonly beforeTokens: number;
    readonly afterTokens: number;
  };
  readonly StageExecution: {
    readonly stageId: string;
    readonly outcome: "ok" | "failed" | "cancelled";
    readonly capHit: boolean;
  };
  readonly ModelSwitch: { readonly from: string; readonly to: string; readonly providerId: string };
  readonly ProviderSwitch: { readonly from: string; readonly to: string };
  readonly ExtensionSetRevision: {
    readonly loaded: readonly string[];
    readonly disabled: readonly string[];
    readonly revisionId: string;
  };
  readonly TrustDecision: {
    readonly subject: string;
    readonly decision: "granted" | "cleared";
    readonly scope: "global" | "project";
  };
  readonly SMTransition: { readonly from: string; readonly to: string; readonly nextKind: string };
  readonly Integrity: { readonly extensionId: string; readonly verdict: "ok" | "mismatch" };
  readonly SessionLifecycle: { readonly event: "start" | "resume" | "save" | "end" };
  readonly SuppressedError: { readonly reason: string; readonly cause: string };
}

export interface AuditRecord<K extends AuditClass = AuditClass> {
  readonly class: K;
  readonly correlationId: string;
  readonly timestamp: number;
  readonly payload: AuditPayloads[K];
}

export function listAuditClasses(): readonly AuditClass[] {
  return AUDIT_CLASSES;
}
