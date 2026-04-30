export const AUDIT_CLASSES = [
  "Approval",
  "Compaction",
  "StageExecution",
  "ModelSwitch",
  "ProviderSwitch",
  "ExtensionsReloaded",
  "TrustDecision",
  "SMTransition",
  "Integrity",
  "SessionLifecycle",
  "Turn",
  "ProviderExchange",
  "ToolInvocation",
  "SuppressedError",
] as const;

export type AuditClass = (typeof AUDIT_CLASSES)[number];

export type TurnPayload =
  | {
      readonly kind: "TurnStarted";
      readonly turnId: string;
      readonly userInput: string;
      readonly historyLength: number;
    }
  | {
      readonly kind: "TurnEnded";
      readonly turnId: string;
      readonly durationMs: number;
      readonly historyLength: number;
      readonly finishReason?: string;
      readonly toolCallCount?: number;
    }
  | {
      readonly kind: "TurnError";
      readonly turnId: string;
      readonly durationMs: number;
      readonly errorClass?: string;
      readonly errorCode?: string;
      readonly message?: string;
    };

export type ProviderExchangePayload =
  | {
      readonly kind: "ProviderRequest";
      readonly providerId: string;
      readonly modelId: string;
      readonly estimatedInputTokens?: number;
      readonly messages?: readonly unknown[];
      readonly tools?: readonly unknown[];
    }
  | {
      readonly kind: "ProviderResponse";
      readonly providerId: string;
      readonly modelId: string;
      readonly finishReason: string;
      readonly assistantText?: string;
      readonly toolCalls?: readonly unknown[];
      readonly estimatedOutputTokens?: number;
      readonly durationMs: number;
      readonly error?: Readonly<Record<string, unknown>>;
    };

export type ToolInvocationPayload =
  | {
      readonly kind: "ToolCallStarted";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
    }
  | {
      readonly kind: "ToolCallSucceeded";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly normalizedArgs?: unknown;
      readonly durationMs: number;
      readonly result?: unknown;
    }
  | {
      readonly kind: "ToolCallFailed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly normalizedArgs?: unknown;
      readonly durationMs?: number;
      readonly error?: Readonly<Record<string, unknown>>;
    };

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
  readonly ExtensionsReloaded: {
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
  readonly Turn: TurnPayload;
  readonly ProviderExchange: ProviderExchangePayload;
  readonly ToolInvocation: ToolInvocationPayload;
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
