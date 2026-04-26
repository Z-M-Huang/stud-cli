/**
 * Default-chat flow harness — drives a single turn through the message-loop
 * orchestrator and captures the emitted event sequence.
 *
 * Scope. The harness composes the message-loop orchestrator with stage
 * handlers that mimic the data flow a real default-chat turn produces,
 * but does NOT wire a live provider or session store. The cli-wrapper
 * provider is exercised in `tests/extensions/providers/cli-wrapper/`;
 * the filesystem session store is exercised in
 * `tests/extensions/session-stores/filesystem/`. This harness asserts the
 * end-to-end event invariants — fixed six-stage order, single correlation
 * ID, terminal SessionTurnStart/SessionTurnEnd brackets, no TOOL_CALL on
 * a no-tool prompt — that no per-component test is in a position to verify
 * (they each see only their own slice of the loop).
 *
 * Returns the captured events in order plus the final rendered output.
 *
 * Wiki: flows/Default-Chat.md + core/Message-Loop.md
 */

import { createEventBus } from "../../../src/core/events/bus.js";
import { createCorrelationFactory } from "../../../src/core/events/correlation.js";
import { createMessageLoop } from "../../../src/core/loop/orchestrator.js";

import type { LoopBound } from "../../../src/core/loop/loop-bound.js";
import type { StageInput, StageName, StageOutput } from "../../../src/core/loop/orchestrator.js";

export interface CapturedEvent {
  readonly name: string;
  readonly correlationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DefaultChatTurnInput {
  readonly projectRoot: string;
  readonly prompt: string;
  /** Optional override: mark this turn as one that calls a tool. */
  readonly requestsTool?: boolean;
}

export interface DefaultChatTurnResult {
  readonly events: readonly CapturedEvent[];
  readonly finalOutput: string;
  readonly correlationId: string;
}

const FIXED_ORDER: readonly StageName[] = [
  "RECEIVE_INPUT",
  "COMPOSE_REQUEST",
  "SEND_REQUEST",
  "STREAM_RESPONSE",
  "TOOL_CALL",
  "RENDER",
] as const;

function nextOf(stage: StageName): StageName | "END_OF_TURN" {
  const idx = FIXED_ORDER.indexOf(stage);
  return idx + 1 < FIXED_ORDER.length ? FIXED_ORDER[idx + 1]! : "END_OF_TURN";
}

const DEFAULT_BOUND: LoopBound = { kind: "default-chat", maxIterations: 10 };

/**
 * Drive a single default-chat turn and return captured events + output.
 *
 * The harness:
 *   1. Builds an isolated event bus and correlation factory.
 *   2. Registers six stage handlers mirroring the documented data flow.
 *      - RECEIVE_INPUT normalises the prompt.
 *      - COMPOSE_REQUEST appends to a transient history.
 *      - SEND_REQUEST records the dispatch.
 *      - STREAM_RESPONSE returns text-delta tokens that build the
 *        final output. When `requestsTool` is true, signals TOOL_CALL.
 *      - TOOL_CALL records a tool invocation and returns to RENDER.
 *      - RENDER persists the rendered text and ends the turn.
 *   3. Drives `loop.runTurn` once and captures every bus event.
 *
 * The `projectRoot` parameter is recorded on each stage payload so a
 * future test can assert it is propagated; the harness does not write
 * to disk.
 */
export async function runDefaultChatTurn(
  input: DefaultChatTurnInput,
): Promise<DefaultChatTurnResult> {
  let tick = 0n;
  const bus = createEventBus({ monotonic: () => ++tick });
  const correlation = createCorrelationFactory({
    rng: () => "test-rng",
    monotonic: () => tick,
  });
  const loop = createMessageLoop({ bus, correlation });

  const captured: CapturedEvent[] = [];
  bus.onAny((ev) => {
    captured.push({
      name: ev.name,
      correlationId: ev.correlationId ?? "",
      payload: (ev.payload ?? {}) as Readonly<Record<string, unknown>>,
    });
  });

  let renderedOutput = "";

  for (const stage of FIXED_ORDER) {
    loop.registerStage(stage, (_stageInput: StageInput): Promise<StageOutput> => {
      const carriedPayload = {
        projectRoot: input.projectRoot,
        prompt: input.prompt,
        renderedSoFar: renderedOutput,
      };

      if (stage === "STREAM_RESPONSE") {
        renderedOutput = `echo: ${input.prompt}`;
        const next: StageName | "END_OF_TURN" =
          input.requestsTool === true ? "TOOL_CALL" : "END_OF_TURN";
        return Promise.resolve({ next, payload: { ...carriedPayload, body: renderedOutput } });
      }

      if (stage === "TOOL_CALL") {
        // Always return to RENDER after a single tool call (no continuation).
        return Promise.resolve({ next: "RENDER", payload: carriedPayload });
      }

      if (stage === "RENDER") {
        return Promise.resolve({ next: "END_OF_TURN", payload: carriedPayload });
      }

      // Linear stages (RECEIVE_INPUT, COMPOSE_REQUEST, SEND_REQUEST).
      return Promise.resolve({ next: nextOf(stage), payload: carriedPayload });
    });
  }

  const correlationId = correlation.nextTurnId();
  await loop.runTurn(
    { stage: "RECEIVE_INPUT", correlationId, payload: { prompt: input.prompt } },
    DEFAULT_BOUND,
  );

  return {
    events: captured,
    finalOutput: renderedOutput,
    correlationId,
  };
}
