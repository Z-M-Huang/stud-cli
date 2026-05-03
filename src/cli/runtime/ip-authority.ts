/**
 * Parent-session-level Interaction Protocol authority.
 *
 * Wraps the existing event-bus-based interaction path with a single queue
 * per parent session, ordered by:
 *
 *   1. `raisedAt` (primary key) — monotonic timestamp assigned at enqueue.
 *   2. Subagent `spawnedAt` (tiebreaker for child requests on the same tick).
 *   3. `raiseSequenceWithinSubagent` (tiebreaker for same-subagent ties).
 *   4. Stable arrival order (parent-vs-parent ties).
 *
 * Wiki: core/Interaction-Protocol.md §Multiple interactors and
 * core/Subagent-Sessions.md §Cross-subagent serialization.
 *
 * Parent requests have no `subagentId` and never get priority over child
 * requests — they participate by `raisedAt` only. In normal operation
 * `raisedAt` is monotonic so the comparator degenerates to FIFO; the
 * tie-breaks fire only when concurrent emissions land on the same monotonic
 * tick. Wiki: D4a in
 * /home/ubuntu/.claude/plans/ultrathink-we-have-a-magical-gem.md.
 *
 * The Authority preserves the existing `InteractionRaised`/
 * `InteractionAnswered` event payload contract that the bundled TUI
 * subscribes to (`extensions/ui/default-tui/lifecycle.ts`). It does not
 * use the unwired `core/interaction/protocol.ts createInteractionProtocol`
 * because that emitter shape (`{kind, correlationId}` only) does not match
 * the TUI's expectation (`{kind, prompt, options?, requestId, correlationId}`).
 */

import { randomUUID } from "node:crypto";

import { Cancellation, ToolTransient, Validation } from "../../core/errors/index.js";

import type { EventsAPI } from "../../core/host/api/events.js";
import type {
  InteractionAPI,
  InteractionRequest,
  InteractionResult,
} from "../../core/host/api/interaction.js";

interface InteractionAnsweredPayload {
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly status?: "accepted" | "rejected" | "timeout" | "halt";
  readonly value?: unknown;
  readonly reason?: string;
}

/**
 * Subagent context attached to an enqueued IP request when the originator is
 * a child session.
 */
export interface SubagentAttribution {
  readonly subagentId: string;
  readonly parentSessionId: string;
  readonly spawnedAt: number;
  readonly raiseSequenceWithinSubagent: number;
}

interface QueueEntry {
  readonly request: InteractionRequest;
  readonly attribution: SubagentAttribution | undefined;
  /**
   * Display-only attribution: the dialog renderer sees this on the
   * `InteractionRaised` payload but the queue comparator does not use it
   * (the parent's request still sorts by `raisedAt`, never by spawn order).
   * Used by `approveSubagentEnvelope` to surface the subagent chip BEFORE
   * the child has been registered with the authority.
   */
  readonly displayContext?: {
    readonly subagentId: string;
    readonly parentSessionId: string;
    readonly depth: number;
    readonly subagentLabel?: string;
    /** Resolved (providerId, modelId) shown on the envelope dialog chip. */
    readonly model?: { readonly providerId: string; readonly modelId: string };
    /** Approved envelope tool flat-names. */
    readonly requestedEnvelope?: readonly string[];
    /** Truncated prompt for at-a-glance review. */
    readonly promptSummary?: string;
  };
  readonly raisedAt: number;
  /** Stable arrival counter — last-resort tiebreaker (parent-vs-parent). */
  readonly arrivalOrder: number;
  readonly settle: (
    response:
      | { ok: true; value: string }
      | {
          ok: false;
          reason: string;
          status: "rejected" | "timeout" | "halt";
          requestId?: string;
        },
  ) => void;
}

export interface IpAuthority extends InteractionAPI {
  /**
   * Register a subagent for the parent-session IP queue. Subsequent calls to
   * `raiseFromSubagent` from this child use the registered `spawnedAt` as the
   * cross-subagent tiebreaker. The raise-sequence counter resets per child.
   */
  registerSubagent(input: { subagentId: string; parentSessionId: string; spawnedAt: number }): void;
  /** Unregister a subagent on terminal state. */
  unregisterSubagent(subagentId: string): void;
  /**
   * Raise an IP request attributed to a child session. Subject to the
   * spawn-ordered comparator on cross-subagent ties.
   */
  raiseFromSubagent(subagentId: string, request: InteractionRequest): Promise<InteractionResult>;
  /**
   * Raise an IP request that originates from the parent session but carries
   * attribution for a specific subagent (e.g., the `approveSubagentEnvelope`
   * IP fired BEFORE the child is registered with the authority). The
   * payload's `subagentId`/`depth`/`subagentLabel` fields appear on the
   * emitted `InteractionRaised` event so dialog renderers can show the
   * subagent chip. Wiki: core/Interaction-Protocol.md §subagentId attribution.
   */
  raiseWithSubagentContext(
    request: InteractionRequest,
    context: {
      readonly subagentId: string;
      readonly parentSessionId: string;
      readonly depth: number;
      readonly subagentLabel?: string;
      readonly model?: { readonly providerId: string; readonly modelId: string };
      readonly requestedEnvelope?: readonly string[];
      readonly promptSummary?: string;
    },
  ): Promise<InteractionResult>;
}

interface RegisteredSubagent {
  readonly parentSessionId: string;
  readonly spawnedAt: number;
  raiseSequence: number;
}

function compareEntries(a: QueueEntry, b: QueueEntry): number {
  if (a.raisedAt !== b.raisedAt) return a.raisedAt - b.raisedAt;
  // Same raisedAt — apply tiebreakers.
  const aSub = a.attribution;
  const bSub = b.attribution;
  if (aSub !== undefined && bSub !== undefined) {
    if (aSub.subagentId !== bSub.subagentId) {
      // Cross-subagent tie: lower spawnedAt wins.
      return aSub.spawnedAt - bSub.spawnedAt;
    }
    // Same subagent: lower raise-sequence wins.
    return aSub.raiseSequenceWithinSubagent - bSub.raiseSequenceWithinSubagent;
  }
  // Mixed (one parent, one child) or both parent: arrival order. Parent does
  // NOT win by priority — wiki D4a says "the orchestrator does not have
  // priority over its children" and "by the same time-of-raise ordering."
  return a.arrivalOrder - b.arrivalOrder;
}

function settleEntry(
  entry: QueueEntry,
  result:
    | { ok: true; value: string }
    | {
        ok: false;
        reason: string;
        status: "rejected" | "timeout" | "halt";
        requestId?: string;
      },
): void {
  entry.settle(result);
}

function buildEventPayload(entry: QueueEntry, requestId: string): Record<string, unknown> {
  const eventPayload: Record<string, unknown> = {
    kind: entry.request.kind,
    prompt: entry.request.prompt,
    options: entry.request.options,
    requestId,
    correlationId: requestId,
  };
  if (entry.attribution !== undefined) {
    eventPayload["subagentId"] = entry.attribution.subagentId;
    eventPayload["parentSessionId"] = entry.attribution.parentSessionId;
    eventPayload["spawnedAt"] = entry.attribution.spawnedAt;
  }
  // Display-only context (envelope-approval before subagent registration).
  const dc = entry.displayContext;
  if (dc !== undefined) {
    eventPayload["subagentId"] = dc.subagentId;
    eventPayload["parentSessionId"] = dc.parentSessionId;
    eventPayload["depth"] = dc.depth;
    if (dc.subagentLabel !== undefined) eventPayload["subagentLabel"] = dc.subagentLabel;
    if (dc.model !== undefined) eventPayload["model"] = dc.model;
    if (dc.requestedEnvelope !== undefined)
      eventPayload["requestedEnvelope"] = dc.requestedEnvelope;
    if (dc.promptSummary !== undefined) eventPayload["promptSummary"] = dc.promptSummary;
  }
  return eventPayload;
}

function runEntryAgainst(events: EventsAPI, entry: QueueEntry): Promise<void> {
  return new Promise<void>((finishEntry) => {
    const requestId = randomUUID();
    let timer: NodeJS.Timeout | undefined;

    const handler = (payload: unknown): void => {
      if (!matchesRequest(payload, requestId)) return;
      events.off("InteractionAnswered", handler);
      if (timer !== undefined) clearTimeout(timer);

      const status = readStatus(payload);
      if (status === "accepted") {
        settleEntry(entry, { ok: true, value: readValue(payload) });
      } else if (status === "timeout") {
        settleEntry(entry, { ok: false, status: "timeout", reason: "interactor timeout" });
      } else if (status === "halt") {
        settleEntry(entry, {
          ok: false,
          status: "halt",
          reason: readReason(payload) ?? "headless without --yolo",
          requestId,
        });
      } else {
        settleEntry(entry, { ok: false, status: "rejected", reason: "interactor rejected" });
      }
      finishEntry();
    };
    events.on("InteractionAnswered", handler);

    const timeoutMs = entry.request.timeoutMs;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        events.off("InteractionAnswered", handler);
        settleEntry(entry, { ok: false, status: "timeout", reason: "ip-authority timeout" });
        finishEntry();
      }, timeoutMs);
    }

    events.emit("InteractionRaised", buildEventPayload(entry, requestId));
  });
}

/**
 * Build the parent-session IP Authority. Replaces the previous
 * `buildInteractionAPI` event-bus-only path.
 */
export function createIpAuthority(deps: {
  readonly events: EventsAPI;
  readonly now?: () => number;
}): IpAuthority {
  const events = deps.events;
  const now = deps.now ?? ((): number => Date.now());
  const subagents = new Map<string, RegisteredSubagent>();
  const queue: QueueEntry[] = [];
  let arrivalCounter = 0;
  let processing = false;

  function enqueue(
    request: InteractionRequest,
    attribution: SubagentAttribution | undefined,
    displayContext?: QueueEntry["displayContext"],
  ): Promise<InteractionResult> {
    return new Promise<InteractionResult>((resolve, reject) => {
      const entry: QueueEntry = {
        request,
        attribution,
        ...(displayContext !== undefined ? { displayContext } : {}),
        raisedAt: now(),
        arrivalOrder: arrivalCounter,
        settle: (result) => {
          if (result.ok) {
            resolve({ value: result.value });
          } else if (result.status === "timeout") {
            reject(
              new ToolTransient("interaction timed out", undefined, {
                code: "ExecutionTimeout",
                reason: result.reason,
              }),
            );
          } else if (result.status === "halt") {
            reject(
              new Validation("interactor unavailable in headless mode", undefined, {
                code: "HeadlessInteractionRequired",
                reason: result.reason,
                ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
              }),
            );
          } else {
            reject(
              new Cancellation("user cancelled the interaction", undefined, {
                code: "TurnCancelled",
                reason: result.reason,
              }),
            );
          }
        },
      };
      arrivalCounter += 1;
      queue.push(entry);
      // Defer to a microtask so concurrent same-tick raises all land in the
      // queue BEFORE the comparator sorts. Without this, the first enqueue
      // starts processing synchronously and later same-tick raises never
      // get sorted against it — breaking the D4a cross-subagent tiebreaker.
      queueMicrotask(() => {
        void processNext();
      });
    });
  }

  async function processNext(): Promise<void> {
    if (processing) return;
    if (queue.length === 0) return;
    processing = true;

    try {
      while (queue.length > 0) {
        // Re-sort on every dequeue so a subagent registered after older
        // entries enqueue still gets compared correctly.
        queue.sort(compareEntries);
        const entry = queue.shift()!;

        await runEntryAgainst(events, entry);
      }
    } finally {
      processing = false;
    }
  }

  return buildAuthorityShape(enqueue, subagents);
}

function buildAuthorityShape(
  enqueue: (
    request: InteractionRequest,
    attribution: SubagentAttribution | undefined,
    displayContext?: QueueEntry["displayContext"],
  ) => Promise<InteractionResult>,
  subagents: Map<string, RegisteredSubagent>,
): IpAuthority {
  return {
    raise(request) {
      return enqueue(request, undefined);
    },
    raiseWithSubagentContext(request, context) {
      // Parent-side raise that surfaces subagent attribution on the dialog
      // chip. The queue still sorts by `raisedAt` (parent does NOT get
      // priority via spawn order) — see D4a.
      return enqueue(request, undefined, context);
    },
    raiseFromSubagent(subagentId, request) {
      const entry = subagents.get(subagentId);
      if (entry === undefined) {
        return Promise.reject(
          new Cancellation("subagent not registered with ip-authority", undefined, {
            code: "TurnCancelled",
            subagentId,
          }),
        );
      }
      const attribution: SubagentAttribution = {
        subagentId,
        parentSessionId: entry.parentSessionId,
        spawnedAt: entry.spawnedAt,
        raiseSequenceWithinSubagent: entry.raiseSequence,
      };
      entry.raiseSequence += 1;
      return enqueue(request, attribution);
    },
    registerSubagent(input) {
      subagents.set(input.subagentId, {
        parentSessionId: input.parentSessionId,
        spawnedAt: input.spawnedAt,
        raiseSequence: 0,
      });
    },
    unregisterSubagent(subagentId) {
      subagents.delete(subagentId);
    },
  };
}

function matchesRequest(payload: unknown, requestId: string): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as InteractionAnsweredPayload;
  return p.requestId === requestId || p.correlationId === requestId;
}

function readStatus(payload: unknown): "accepted" | "rejected" | "timeout" | "halt" {
  const status =
    typeof payload === "object" && payload !== null
      ? (payload as InteractionAnsweredPayload).status
      : undefined;
  return status ?? "rejected";
}

function readValue(payload: unknown): string {
  const raw =
    typeof payload === "object" && payload !== null
      ? (payload as InteractionAnsweredPayload).value
      : undefined;
  return typeof raw === "string" ? raw : "";
}

function readReason(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const reason = (payload as InteractionAnsweredPayload).reason;
  return typeof reason === "string" ? reason : undefined;
}
