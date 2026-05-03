/**
 * Headless / non-Ink fallback interactor binding.
 *
 * Subscribes to `InteractionRaised` events on the parent session's event bus
 * and answers each request through the supplied {@link PromptIO}. Without
 * this binding the IP Authority would `raise()` and hang forever in headless
 * mode because there's no Ink dialog component to dispatch the answer.
 *
 * On headless without `--yolo` the prompt throws `Validation/
 * HeadlessInteractionRequired`; we surface that as `status: "halt"` so the
 * IP Authority's caller observes a structured halt (and `subagent-spawn` can
 * map it to a typed `haltStatus` shape) — NOT a generic Cancellation that
 * masquerades as user cancel.
 *
 * Wiki: runtime/Headless-and-Interactor.md (1.1.0) §Tool-trust auto-approval
 * + core/Subagent-Sessions.md §Headless behavior.
 */

import { Validation } from "../../../core/errors/validation.js";

import type { PromptIO, SelectOption } from "../../../cli/prompt.js";
import type { EventBus } from "../../../core/events/bus.js";

interface RaisedPayload {
  readonly kind?: string;
  readonly prompt?: string;
  readonly options?: readonly string[];
  readonly requestId?: string;
  readonly correlationId?: string;
}

const APPROVE_DENY: readonly SelectOption<string>[] = [
  { value: "approve", label: "approve and remember for this session" },
  { value: "deny", label: "deny" },
] as const;

export function bindFallbackInteractor(bus: EventBus, prompt: PromptIO): void {
  bus.on("InteractionRaised", (envelope) => {
    void answerOne(envelope.payload as RaisedPayload, bus, prompt);
  });
}

async function answerOne(raised: RaisedPayload, bus: EventBus, prompt: PromptIO): Promise<void> {
  const requestId = raised.requestId ?? raised.correlationId;
  if (typeof requestId !== "string" || requestId.length === 0) return;
  const promptText = raised.prompt ?? "";

  try {
    const value = await dispatch(raised, prompt, promptText);
    bus.emit({
      name: "InteractionAnswered",
      correlationId: requestId,
      monotonicTs: process.hrtime.bigint(),
      payload: { requestId, correlationId: requestId, status: "accepted", value },
    });
  } catch (err) {
    // Distinguish headless-emit-and-halt from user-cancel: the prompt's
    // `Validation/HeadlessInteractionRequired` becomes `status: "halt"` so
    // the IP Authority's caller throws `Validation/HeadlessInteractionRequired`
    // (a typed halt). Any other failure remains `rejected` (Cancellation).
    if (err instanceof Validation && err.context["code"] === "HeadlessInteractionRequired") {
      bus.emit({
        name: "InteractionAnswered",
        correlationId: requestId,
        monotonicTs: process.hrtime.bigint(),
        payload: {
          requestId,
          correlationId: requestId,
          status: "halt",
          reason: "headless without --yolo",
        },
      });
      return;
    }
    bus.emit({
      name: "InteractionAnswered",
      correlationId: requestId,
      monotonicTs: process.hrtime.bigint(),
      payload: { requestId, correlationId: requestId, status: "rejected" },
    });
  }
}

async function dispatch(
  raised: RaisedPayload,
  prompt: PromptIO,
  promptText: string,
): Promise<string> {
  const kind = raised.kind ?? "select";
  if (kind === "input") {
    return prompt.input(promptText);
  }
  if (kind === "approveSubagentEnvelope" || kind === "confirm") {
    return prompt.select(promptText, APPROVE_DENY);
  }
  // `select` (or any other kind that ships an options list).
  const opts = raised.options ?? [];
  const choices = opts.length > 0 ? opts.map((o) => ({ value: o, label: o })) : APPROVE_DENY;
  return prompt.select(promptText, choices);
}
