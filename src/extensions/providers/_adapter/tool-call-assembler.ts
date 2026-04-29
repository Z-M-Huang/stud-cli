import type { StreamEvent } from "./protocol.js";

export interface ToolCallAssembler {
  ingest(delta: StreamEvent): void;
  drain(): readonly StreamEvent[];
  pending(): readonly string[];
}

interface PendingToolCall {
  name: string;
  argsJson: string;
}

function parseCompletedToolCall(callId: string, pendingCall: PendingToolCall): StreamEvent | null {
  if (pendingCall.name.length === 0 || pendingCall.argsJson.length === 0) {
    return null;
  }

  try {
    return {
      kind: "tool-call",
      callId,
      name: pendingCall.name,
      args: JSON.parse(pendingCall.argsJson) as unknown,
    };
  } catch {
    return null;
  }
}

function malformedToolCallError(callId: string, pending: PendingToolCall): StreamEvent {
  return {
    kind: "error",
    class: "ProviderCapability",
    code: "OutputMalformed",
    message: `Tool call '${callId}' ended before producing valid JSON arguments.`,
    context: {
      callId,
      partialName: pending.name,
      partialArgsJson: pending.argsJson,
      partialArgsLength: pending.argsJson.length,
      partialNameLength: pending.name.length,
    },
  };
}

export function createToolCallAssembler(): ToolCallAssembler {
  const pendingCalls = new Map<string, PendingToolCall>();
  const ready: StreamEvent[] = [];

  return {
    ingest(delta: StreamEvent): void {
      if (delta.kind === "tool-call-delta") {
        if ((delta.nameDelta ?? "").length === 0 && (delta.argsJsonDelta ?? "").length === 0) {
          return;
        }
        const current = pendingCalls.get(delta.callId) ?? { name: "", argsJson: "" };
        const next: PendingToolCall = {
          name: current.name + (delta.nameDelta ?? ""),
          argsJson: current.argsJson + (delta.argsJsonDelta ?? ""),
        };

        const complete = parseCompletedToolCall(delta.callId, next);
        if (complete !== null) {
          pendingCalls.delete(delta.callId);
          ready.push(complete);
          return;
        }

        pendingCalls.set(delta.callId, next);
        return;
      }

      if (delta.kind === "finish") {
        for (const [callId, pending] of pendingCalls) {
          ready.push(malformedToolCallError(callId, pending));
        }
        pendingCalls.clear();
      }
    },

    drain(): readonly StreamEvent[] {
      const drained = ready.slice();
      ready.length = 0;
      return drained;
    },

    pending(): readonly string[] {
      return [...pendingCalls.keys()];
    },
  };
}
