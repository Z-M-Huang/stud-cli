import { ProviderTransient, Validation } from "../errors/index.js";

import type { ChatMessage } from "./assembler.ts";
import type { hasOverflow as HasOverflow } from "./memory.ts";
import type { EventBus, EventEnvelope } from "../events/bus.ts";

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

function emit(eventBus: EventBus, name: string, payload: Record<string, unknown>): void {
  const envelope: EventEnvelope = {
    name,
    correlationId: "history-compaction",
    monotonicTs: 0n,
    payload,
  };
  eventBus.emit(envelope);
}

function estimateTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    const messageWithTurnId = message as MessageWithTurnId;
    const contentTokens = Math.max(1, Math.ceil(message.content.length / 1000));
    const turnIdTokens = typeof messageWithTurnId.turnId === "string" ? 1 : 0;
    return sum + contentTokens + turnIdTokens;
  }, 0);
}

function collectOriginalTurnIds(messages: readonly ChatMessage[]): readonly string[] {
  const ids = new Set<string>();
  for (const message of messages as readonly MessageWithTurnId[]) {
    if (typeof message.turnId === "string" && message.turnId.length > 0) {
      ids.add(message.turnId);
    }
  }
  return [...ids];
}

function exceedsTarget(tokens: number, targetTokens: number): boolean {
  return memoryModule.hasOverflow(tokens, targetTokens);
}

function createSummaryMessage(summary: string, originalTurnIds: readonly string[]): ChatMessage {
  return {
    role: "assistant",
    content: `${summary}\n\n[metadata:${JSON.stringify({ originalTurnIds })}]`,
  };
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

  const originalTokens = estimateTokens(input.history);
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

  const summarySegments: {
    readonly summary: string;
    readonly originalTurnIds: readonly string[];
  }[] = [];

  let compactedMessages = [...input.history];

  if (compactedMessages.length > 1) {
    const segment = compactedMessages.slice(0, -1);
    const originalTurnIds = collectOriginalTurnIds(segment);
    const summary = await summarizeSegment(segment, input.summarize);
    summarySegments.push({ summary, originalTurnIds });
    compactedMessages = [createSummaryMessage(summary, originalTurnIds), compactedMessages.at(-1)!];
  } else if (compactedMessages.length === 1) {
    const originalTurnIds = collectOriginalTurnIds(compactedMessages);
    const summary = await summarizeSegment(compactedMessages, input.summarize);
    summarySegments.push({ summary, originalTurnIds });
    compactedMessages = [createSummaryMessage(summary, originalTurnIds)];
  }

  let compactedTokens = estimateTokens(compactedMessages);

  if (exceedsTarget(compactedTokens, input.targetTokens) && compactedMessages.length > 0) {
    const originalTurnIds = collectOriginalTurnIds(compactedMessages);
    const summary = await summarizeSegment(compactedMessages, input.summarize);
    summarySegments.push({ summary, originalTurnIds });
    compactedMessages = [createSummaryMessage(summary, originalTurnIds)];
    compactedTokens = estimateTokens(compactedMessages);
  }

  if (exceedsTarget(compactedTokens, input.targetTokens)) {
    throw new Validation("compacted history still exceeds target token budget", undefined, {
      code: "ContextOverflow",
      originalTokens,
      compactedTokens,
      targetTokens: input.targetTokens,
    });
  }

  const result: CompactedHistory = {
    messages: compactedMessages,
    summarySegments,
  };

  emit(input.eventBus, "CompactionPerformed", {
    segmentsCompacted: summarySegments.length,
    originalTokens,
    compactedTokens,
  });
  await input.audit.write({
    class: "Compaction",
    segmentsCompacted: summarySegments.length,
    originalTokens,
    compactedTokens,
  });

  return result;
}
