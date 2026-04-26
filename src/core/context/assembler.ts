import { ExtensionHost, Validation } from "../errors/index.js";

import type { EventBus, EventEnvelope } from "../events/bus.js";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface ToolSummary {
  readonly id?: string;
  readonly name?: string;
  readonly schema?: unknown;
}

export interface ContextFragment {
  readonly kind: "system-message" | "prompt-fragment" | "resource-binding" | "tool-hint";
  readonly content: string;
  readonly priority: number;
  readonly budget: number;
  readonly ownerExtId: string;
}

interface ContextProviderHandle {
  readonly ownerExtId: string;
  readonly graceful?: boolean;
  provide(): Promise<readonly ContextFragment[]>;
}

interface TokenBreakdown {
  readonly system: number;
  readonly history: number;
  readonly tools: number;
  readonly fragments: number;
  readonly total: number;
}

export interface AssemblyInput {
  readonly systemPrompt: string;
  readonly history: readonly ChatMessage[];
  readonly toolManifest: readonly ToolSummary[];
  readonly modelParams: Readonly<Record<string, unknown>>;
  readonly modelWindowTokens: number;
  readonly providers: readonly ContextProviderHandle[];
  readonly eventBus: EventBus;
  readonly compact: (history: readonly ChatMessage[]) => Promise<readonly ChatMessage[]>;
}

export interface AssembledRequest {
  readonly systemPrompt: string;
  readonly history: readonly ChatMessage[];
  readonly toolManifest: readonly ToolSummary[];
  readonly fragments: readonly ContextFragment[];
  readonly modelParams: Readonly<Record<string, unknown>>;
  readonly tokenBreakdown: TokenBreakdown;
}

type Tokenizer = (value: string, tokenizerId?: string) => number;

function createCorrelationId(): string {
  return "context-assembly";
}

function emit(eventBus: EventBus, name: string, payload: Record<string, unknown>): void {
  const envelope: EventEnvelope = {
    name,
    correlationId: createCorrelationId(),
    monotonicTs: 0n,
    payload,
  };
  eventBus.emit(envelope);
}

function defaultTokenizer(value: string): number {
  return value.length;
}

function resolveTokenizer(modelParams: Readonly<Record<string, unknown>>): Tokenizer {
  const candidate = modelParams["tokenizer"];
  if (typeof candidate === "function") {
    return candidate as Tokenizer;
  }
  return defaultTokenizer;
}

function countStringTokens(
  value: string,
  tokenizer: Tokenizer,
  tokenizerId: string | undefined,
): number {
  return tokenizer(value, tokenizerId);
}

function countHistoryTokens(
  history: readonly ChatMessage[],
  tokenizer: Tokenizer,
  tokenizerId: string | undefined,
): number {
  return history.reduce((sum, message) => {
    return sum + countStringTokens(`${message.role}:${message.content}`, tokenizer, tokenizerId);
  }, 0);
}

function countToolTokens(
  tools: readonly ToolSummary[],
  tokenizer: Tokenizer,
  tokenizerId: string | undefined,
): number {
  return countStringTokens(JSON.stringify(tools), tokenizer, tokenizerId);
}

function countFragmentTokens(
  fragments: readonly ContextFragment[],
  tokenizer: Tokenizer,
  tokenizerId: string | undefined,
): number {
  return fragments.reduce((sum, fragment) => {
    return sum + countStringTokens(fragment.content, tokenizer, tokenizerId);
  }, 0);
}

function computeBreakdown(args: {
  systemPrompt: string;
  history: readonly ChatMessage[];
  toolManifest: readonly ToolSummary[];
  fragments: readonly ContextFragment[];
  tokenizer: Tokenizer;
  tokenizerId: string | undefined;
}): TokenBreakdown {
  const system = countStringTokens(args.systemPrompt, args.tokenizer, args.tokenizerId);
  const history = countHistoryTokens(args.history, args.tokenizer, args.tokenizerId);
  const tools = countToolTokens(args.toolManifest, args.tokenizer, args.tokenizerId);
  const fragments = countFragmentTokens(args.fragments, args.tokenizer, args.tokenizerId);
  return {
    system,
    history,
    tools,
    fragments,
    total: system + history + tools + fragments,
  };
}

function sortFragments(fragments: readonly ContextFragment[]): readonly ContextFragment[] {
  return [...fragments].sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    return left.ownerExtId.localeCompare(right.ownerExtId);
  });
}

function toContextProviderFailed(error: unknown, ownerExtId: string): ExtensionHost {
  if (error instanceof ExtensionHost && error.context["code"] === "ContextProviderFailed") {
    return error;
  }
  return new ExtensionHost(`Context provider failed: ${ownerExtId}`, error, {
    code: "ContextProviderFailed",
    ownerExtId,
  });
}

async function resolveFragments(input: AssemblyInput): Promise<readonly ContextFragment[]> {
  const fragments: ContextFragment[] = [];

  for (const provider of input.providers) {
    try {
      const resolved = await provider.provide();
      fragments.push(...resolved);
    } catch (error) {
      const wrapped = toContextProviderFailed(error, provider.ownerExtId);
      emit(input.eventBus, "ContextProviderFailed", {
        ownerExtId: provider.ownerExtId,
        graceful: provider.graceful === true,
        code: wrapped.context["code"],
      });
      if (provider.graceful === true) {
        continue;
      }
      throw wrapped;
    }
  }

  return fragments;
}

function validateModelWindow(modelWindowTokens: number): void {
  if (!Number.isInteger(modelWindowTokens) || modelWindowTokens <= 0) {
    throw new Validation("modelWindowTokens must be a positive integer", undefined, {
      code: "ModelWindowInvalid",
      modelWindowTokens,
    });
  }
}

function getTokenizerId(modelParams: Readonly<Record<string, unknown>>): string | undefined {
  return typeof modelParams["tokenizerId"] === "string" ? modelParams["tokenizerId"] : undefined;
}

export function enforcePerProviderBudget(
  fragments: readonly ContextFragment[],
): readonly ContextFragment[] {
  const remainingByOwner = new Map<string, number>();
  const output: ContextFragment[] = [];

  for (const fragment of fragments) {
    const remaining = remainingByOwner.get(fragment.ownerExtId) ?? fragment.budget;
    const tokenCount = fragment.content.length;

    if (remaining <= 0) {
      output.push({ ...fragment, content: "" });
      remainingByOwner.set(fragment.ownerExtId, 0);
      continue;
    }

    if (tokenCount <= remaining) {
      output.push(fragment);
      remainingByOwner.set(fragment.ownerExtId, remaining - tokenCount);
      continue;
    }

    output.push({
      ...fragment,
      content: remaining <= 0 ? "" : fragment.content.slice(0, remaining),
    });
    remainingByOwner.set(fragment.ownerExtId, 0);
  }

  return output;
}

function emitFragmentTruncations(args: {
  eventBus: EventBus;
  sortedFragments: readonly ContextFragment[];
  budgetedFragments: readonly ContextFragment[];
  tokenizer: Tokenizer;
  tokenizerId: string | undefined;
}): void {
  for (const [index, before] of args.sortedFragments.entries()) {
    const after = args.budgetedFragments[index];
    if (before === undefined || after === undefined || after.content === before.content) {
      continue;
    }
    emit(args.eventBus, "FragmentTruncated", {
      ownerExtId: before.ownerExtId,
      beforeTokens: countStringTokens(before.content, args.tokenizer, args.tokenizerId),
      afterTokens: countStringTokens(after.content, args.tokenizer, args.tokenizerId),
    });
  }
}

function buildAssembledRequest(args: {
  input: AssemblyInput;
  history: readonly ChatMessage[];
  fragments: readonly ContextFragment[];
  tokenBreakdown: TokenBreakdown;
}): AssembledRequest {
  return {
    systemPrompt: args.input.systemPrompt,
    history: args.history,
    toolManifest: args.input.toolManifest,
    fragments: args.fragments,
    modelParams: args.input.modelParams,
    tokenBreakdown: args.tokenBreakdown,
  };
}

export async function assembleRequest(input: AssemblyInput): Promise<AssembledRequest> {
  validateModelWindow(input.modelWindowTokens);

  const tokenizer = resolveTokenizer(input.modelParams);
  const tokenizerId = getTokenizerId(input.modelParams);

  emit(input.eventBus, "AssemblyStarted", {
    providerCount: input.providers.length,
    tokenizerId: tokenizerId ?? null,
  });

  const baseBreakdown = computeBreakdown({
    systemPrompt: input.systemPrompt,
    history: input.history,
    toolManifest: input.toolManifest,
    fragments: [],
    tokenizer,
    tokenizerId,
  });
  const resolvedFragments = await resolveFragments(input);
  const sortedFragments = sortFragments(resolvedFragments);
  emit(input.eventBus, "FragmentsResolved", {
    fragmentCount: sortedFragments.length,
    baseTokens: baseBreakdown.total,
  });

  const budgetedFragments = enforcePerProviderBudget(sortedFragments);
  emitFragmentTruncations({
    eventBus: input.eventBus,
    sortedFragments,
    budgetedFragments,
    tokenizer,
    tokenizerId,
  });
  emit(input.eventBus, "BudgetEnforced", {
    fragmentCount: budgetedFragments.length,
  });

  let history = input.history;
  let tokenBreakdown = computeBreakdown({
    systemPrompt: input.systemPrompt,
    history,
    toolManifest: input.toolManifest,
    fragments: budgetedFragments,
    tokenizer,
    tokenizerId,
  });

  const needsCompaction = tokenBreakdown.total > input.modelWindowTokens;
  emit(input.eventBus, "CompactionInvoked", {
    reason: needsCompaction ? "window-exceeded" : "not-needed",
    totalTokens: tokenBreakdown.total,
    modelWindowTokens: input.modelWindowTokens,
  });

  if (needsCompaction) {
    history = await input.compact(history);
    tokenBreakdown = computeBreakdown({
      systemPrompt: input.systemPrompt,
      history,
      toolManifest: input.toolManifest,
      fragments: budgetedFragments,
      tokenizer,
      tokenizerId,
    });
    if (tokenBreakdown.total > input.modelWindowTokens) {
      throw new Validation(
        "assembled context still exceeds model window after compaction",
        undefined,
        {
          code: "ContextOverflow",
          totalTokens: tokenBreakdown.total,
          modelWindowTokens: input.modelWindowTokens,
        },
      );
    }
  }

  const assembled = buildAssembledRequest({
    input,
    history,
    fragments: budgetedFragments,
    tokenBreakdown,
  });
  emit(input.eventBus, "AssemblyCompleted", {
    totalTokens: tokenBreakdown.total,
    modelWindowTokens: input.modelWindowTokens,
    compacted: needsCompaction,
  });

  return assembled;
}
