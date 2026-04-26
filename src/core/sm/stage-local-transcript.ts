/**
 * Stage-local transcript for SM Act execution.
 *
 * Wiki: core/Stage-Executions.md
 */

export interface StageLocalTranscript {
  readonly systemPrompt: string;
  readonly messages: readonly TranscriptMessage[];
  readonly toolManifest: readonly string[];
  readonly completionToolId: string;
  readonly append: (m: TranscriptMessage) => void;
  readonly freeze: () => FrozenStageLocalTranscript;
}

export interface TranscriptMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly correlationId: string;
}

export interface FrozenStageLocalTranscript {
  readonly systemPrompt: string;
  readonly messages: readonly TranscriptMessage[];
  readonly toolManifest: readonly string[];
  readonly completionToolId: string;
}

export function createStageLocalTranscript(args: {
  readonly renderedBody: string;
  readonly allowedTools: readonly string[];
  readonly sessionTools: readonly string[];
  readonly completionToolId: string;
}): StageLocalTranscript {
  const toolManifest = Object.freeze([
    ...args.allowedTools.filter((toolId) => args.sessionTools.includes(toolId)),
    ...(!args.allowedTools.includes(args.completionToolId) ||
    !args.sessionTools.includes(args.completionToolId)
      ? [args.completionToolId]
      : []),
  ]);

  const messages: TranscriptMessage[] = [];
  let frozen: FrozenStageLocalTranscript | undefined;

  return {
    systemPrompt: args.renderedBody,
    get messages() {
      return messages;
    },
    toolManifest,
    completionToolId: args.completionToolId,
    append(message: TranscriptMessage): void {
      if (frozen !== undefined) {
        return;
      }
      messages.push(message);
    },
    freeze(): FrozenStageLocalTranscript {
      if (frozen !== undefined) {
        return frozen;
      }

      frozen = Object.freeze({
        systemPrompt: args.renderedBody,
        messages: Object.freeze([...messages]),
        toolManifest,
        completionToolId: args.completionToolId,
      });
      return frozen;
    },
  };
}
