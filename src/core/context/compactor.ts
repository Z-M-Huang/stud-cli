import { compactMessages } from "agentool/context-compaction";

import { ProviderTransient, Validation } from "../errors/index.js";

import type { ChatMessage } from "./assembler.ts";
import type { hasOverflow as HasOverflow } from "./memory.ts";
import type { EventBus, EventEnvelope } from "../events/bus.ts";
import type { ModelMessage } from "ai";

interface MemoryModule {
  readonly hasOverflow: typeof HasOverflow;
}

const memoryModule = (await import(new URL("./memory.ts", import.meta.url).href)) as MemoryModule;

export interface AuditWriter {
  write(record: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface CompactorInput {
  readonly history: readonly ChatMessage[];
  readonly targetTokens: number;
  readonly summarize: (messages: readonly ChatMessage[]) => Promise<string>;
  readonly audit: AuditWriter;
  readonly eventBus: EventBus;
}

export interface CompactedHistory {
  readonly messages: readonly ChatMessage[];
  readonly summarySegments: readonly {
    readonly summary: string;
    readonly originalTurnIds: readonly string[];
  }[];
}

type MessageWithTurnId = ChatMessage & { readonly turnId?: string };
type ModelMessageWithTurnId = ModelMessage & { readonly turnId?: string };

function stringifyUnknown(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function emit(eventBus: EventBus, name: string, payload: Record<string, unknown>): void {
  const envelope: EventEnvelope = {
    name,
    correlationId: "history-compaction",
    monotonicTs: 0n,
    payload,
  };
  eventBus.emit(envelope);
}

function contentTokens(content: unknown): number {
  const text = stringifyUnknown(content);
  return Math.max(1, Math.ceil(text.length / 1000));
}

function estimateModelTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((sum, message) => {
    const messageWithTurnId = message as ModelMessageWithTurnId;
    const tokens = contentTokens((message as { readonly content?: unknown }).content);
    const turnIdTokens = typeof messageWithTurnId.turnId === "string" ? 1 : 0;
    return sum + tokens + turnIdTokens;
  }, 0);
}

function collectOriginalTurnIds(
  messages: readonly (ChatMessage | ModelMessage)[],
): readonly string[] {
  const ids = new Set<string>();
  for (const message of messages as readonly (MessageWithTurnId | ModelMessageWithTurnId)[]) {
    if (typeof message.turnId === "string" && message.turnId.length > 0) {
      ids.add(message.turnId);
    }
  }
  return [...ids];
}

function exceedsTarget(tokens: number, targetTokens: number): boolean {
  return memoryModule.hasOverflow(tokens, targetTokens);
}

async function summarizeSegment(
  messages: readonly ChatMessage[],
  summarize: CompactorInput["summarize"],
): Promise<string> {
  try {
    return await summarize(messages);
  } catch (error) {
    throw new ProviderTransient("history summarization failed", error, {
      code: "SummarizeFailed",
    });
  }
}

function toModelMessage(message: ChatMessage): ModelMessage {
  const withTurnId = message as MessageWithTurnId;
  return {
    role: message.role,
    content: message.content,
    ...(withTurnId.turnId === undefined ? {} : { turnId: withTurnId.turnId }),
  } as unknown as ModelMessage;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return stringifyUnknown(content);
  }
  return content
    .map((part) => {
      const record = part as Readonly<Record<string, unknown>>;
      if (typeof record["text"] === "string") return record["text"];
      if (typeof record["content"] === "string") return record["content"];
      return JSON.stringify(record);
    })
    .join("\n");
}

function toChatMessage(message: ModelMessage): ChatMessage {
  const record = message as Readonly<Record<string, unknown>>;
  return {
    role: record["role"] as ChatMessage["role"],
    content: contentToText(record["content"]),
  };
}

function summaryTargetTokens(maxContextTokens: number): number {
  return Math.max(1, Math.min(maxContextTokens - 1, Math.floor(maxContextTokens * 0.2)));
}

async function compactWithAgentool(input: CompactorInput): Promise<{
  readonly messages: readonly ModelMessage[];
  readonly summarySegments: CompactedHistory["summarySegments"];
}> {
  const messages = input.history.map(toModelMessage);
  const summarySegments: CompactedHistory["summarySegments"][number][] = [];
  const maxContextTokens = Math.max(input.targetTokens, 2);
  const compacted = await compactMessages({
    messages,
    maxContextTokens,
    autoCompactThresholdPct: input.targetTokens / maxContextTokens,
    reservedOutputTokens: 0,
    summaryTargetTokens: summaryTargetTokens(maxContextTokens),
    keepRecentMessages: 1,
    estimateTokens: estimateModelTokens,
    onCompactionFailure: "throw",
    summarize: async (olderHistory) => {
      const summary = await summarizeSegment(olderHistory.map(toChatMessage), input.summarize);
      summarySegments.push({ summary, originalTurnIds: collectOriginalTurnIds(olderHistory) });
      return summary;
    },
  });
  return { messages: compacted, summarySegments };
}

function validateTargetTokens(targetTokens: number): void {
  if (!Number.isInteger(targetTokens) || targetTokens <= 0) {
    throw new Validation("targetTokens must be a positive integer", undefined, {
      code: "ContextOverflow",
      targetTokens,
    });
  }
}

export async function compactHistory(input: CompactorInput): Promise<CompactedHistory> {
  validateTargetTokens(input.targetTokens);

  const originalTokens = estimateModelTokens(input.history.map(toModelMessage));
  emit(input.eventBus, "CompactionInvoked", {
    totalTokens: originalTokens,
    targetTokens: input.targetTokens,
  });

  if (!exceedsTarget(originalTokens, input.targetTokens)) {
    const result: CompactedHistory = {
      messages: input.history,
      summarySegments: [],
    };
    emit(input.eventBus, "CompactionPerformed", {
      segmentsCompacted: 0,
      originalTokens,
      compactedTokens: originalTokens,
    });
    await input.audit.write({
      class: "Compaction",
      segmentsCompacted: 0,
      originalTokens,
      compactedTokens: originalTokens,
    });
    return result;
  }

  let compacted;
  try {
    compacted = await compactWithAgentool(input);
  } catch (error) {
    if (error instanceof ProviderTransient) {
      throw error;
    }
    throw new Validation("compacted history still exceeds target token budget", error, {
      code: "ContextOverflow",
      originalTokens,
      targetTokens: input.targetTokens,
    });
  }

  const compactedTokens = estimateModelTokens(compacted.messages);
  if (exceedsTarget(compactedTokens, input.targetTokens)) {
    throw new Validation("compacted history still exceeds target token budget", undefined, {
      code: "ContextOverflow",
      originalTokens,
      compactedTokens,
      targetTokens: input.targetTokens,
    });
  }

  const result: CompactedHistory = {
    messages: compacted.messages.map(toChatMessage),
    summarySegments: compacted.summarySegments,
  };

  emit(input.eventBus, "CompactionPerformed", {
    segmentsCompacted: compacted.summarySegments.length,
    originalTokens,
    compactedTokens,
  });
  await input.audit.write({
    class: "Compaction",
    segmentsCompacted: compacted.summarySegments.length,
    originalTokens,
    compactedTokens,
  });

  return result;
}
