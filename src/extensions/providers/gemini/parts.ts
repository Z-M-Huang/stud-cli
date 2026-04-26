import type { WireEvent } from "../_adapter/stream-mapper.js";

export interface GeminiContentPart {
  readonly text?: string;
  readonly functionCall?: { readonly name: string; readonly args: unknown };
  readonly functionResponse?: { readonly name: string; readonly response: unknown };
  readonly inlineData?: { readonly mimeType: string; readonly data: string };
}

function toolCallId(name: string, ordinal: number): string {
  return `gemini-${ordinal}-${name}`;
}

function inlineDataUri(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

function normalizeGeminiPart(part: GeminiContentPart, ordinal: number): readonly WireEvent[] {
  if (typeof part.text === "string") {
    return [{ kind: "text-delta", text: part.text }];
  }

  if (part.functionCall !== undefined) {
    return [
      {
        kind: "tool-call",
        callId: toolCallId(part.functionCall.name, ordinal),
        name: part.functionCall.name,
        args: part.functionCall.args,
      },
    ];
  }

  if (part.functionResponse !== undefined) {
    return [
      {
        kind: "source-citation",
        uri: `gemini:functionResponse/${part.functionResponse.name}`,
        excerpt: JSON.stringify(part.functionResponse.response),
      },
    ];
  }

  if (part.inlineData?.mimeType.startsWith("image/") === true) {
    return [
      {
        kind: "source-citation",
        uri: inlineDataUri(part.inlineData.mimeType, part.inlineData.data),
      },
    ];
  }

  return [];
}

export function normalizeGeminiParts(parts: readonly GeminiContentPart[]): readonly WireEvent[] {
  return parts.flatMap((part, index) => normalizeGeminiPart(part, index));
}
