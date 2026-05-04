/**
 * Runtime closure that backs `host.session.openChild()` for the parent
 * session. Wires together:
 *
 *   - The parent's `SessionSubagentRegistry` (lifecycle bookkeeping mirror).
 *   - The parent's `IpAuthority` (so the `approveSubagentEnvelope` IP request
 *     and any out-of-envelope child IP requests serialize through the same
 *     queue per Phase C / D4a).
 *   - The audit bus (so `SubagentSpawned` / `SubagentEnvelopeApproved` /
 *     `SubagentEnvelopeDenied` / terminal records are emitted on the same
 *     correlation chain as the orchestrator's audit).
 *   - The parent's session scope (so a `child-session` scope cascades from
 *     the parent's session AbortSignal — wiki/core/Subagent-Sessions.md
 *     §Cancellation cascade).
 *
 * The actual child-session loop is delegated to {@link runChildSession} from
 * `core/subagent/run-child.ts`; this module supplies the runtime adapters
 * that resolve provider iterations, tool approvals, and tool execution
 * inside the child loop.
 *
 * Wiki: core/Host-API.md §session.openChild +
 * reference-extensions/tools/Delegate-Tool.md §Validation order +
 * /home/ubuntu/.claude/plans/ultrathink-we-have-a-magical-gem.md §Phase E.
 */

import { Cancellation, Validation } from "../../core/errors/index.js";
import { wrapChildAudit } from "../../core/subagent/run-child.js";
import {
  openChild as coreOpenChild,
  type OpenChildContext,
  type ProviderModelLookup,
} from "../../core/subagent/spawn.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { IpAuthority } from "./ip-authority.js";
import type { LoadedTool } from "./types.js";
import type { SubagentRecord } from "../../contracts/subagent.js";
import type { Scope } from "../../core/concurrency/scope.js";
import type { OpenChildArgs, OpenChildResult } from "../../core/host/api/session.js";
import type { SessionSubagentRegistry } from "../../core/subagent/registry.js";

/**
 * Adapter callbacks the runtime supplies to drive the child loop. The factory
 * keeps these injected (rather than reaching into the runtime directly) so
 * the closure stays unit-testable.
 */
export interface ChildRunner {
  /**
   * Run the child session from `Spawned` through one terminal state.
   * Implementations dispatch through `runChildSession` with deps wired to
   * the runtime's iteration / tool-resolver paths. The runtime is
   * responsible for emitting `SubagentSpawned` and the matching terminal
   * record on the parent's audit bus (with attribution stamped).
   */
  run(input: {
    record: SubagentRecord;
    prompt: string;
    signal: AbortSignal;
  }): Promise<OpenChildResult>;
}

export interface OpenChildClosureDeps {
  readonly parentSessionId: string;
  /** Current depth of the parent session (0 for the orchestrator). */
  readonly parentDepth: number;
  /** Resolved `delegate.maxDepth` config value. */
  readonly maxDepth: number;
  /** Returns the parent's currently-active provider/model at call time. */
  readonly currentParentModel: () => { readonly providerId: string; readonly modelId: string };
  /** Live tool manifest at call time — feeds the envelope subset check. */
  readonly currentToolNames: () => readonly string[];
  /** Live registry — mirror of `audit.activeSubagents()`. */
  readonly registry: SessionSubagentRegistry;
  /** Provider/model validation surface (built from layered settings). */
  readonly providerModelLookup: ProviderModelLookup;
  /** IP Authority — the spawn-approval IP and child IP requests both flow here. */
  readonly ipAuthority: IpAuthority;
  /** Parent session's audit bus — child audits stamp attribution onto it. */
  readonly auditBus: SessionAuditBus;
  /** Parent session's scope — child session scope is built as a child of this. */
  readonly parentSessionScope: Scope;
  /** Adapter that drives the actual child-session loop. */
  readonly childRunner: ChildRunner;
  /** Monotonic timestamp for spawn ordering. */
  readonly now?: () => number;
  /**
   * Predicate returning true when the session is running with `--yolo` (or
   * `mode: yolo`). Used to auto-approve `approveSubagentEnvelope` per
   * wiki/runtime/Headless-and-Interactor.md (1.1.0) §Tool-trust
   * auto-approval — interactive `--yolo` skips tool-trust IP prompts.
   */
  readonly isYolo?: () => boolean;
}

/**
 * Build the runtime `openChild` closure. Wires the parent SessionContext
 * dependencies into a single function the host can call without leaking
 * those dependencies into `provider-host.ts` (which only needs a typed
 * closure).
 */
export function buildOpenChildClosure(
  deps: OpenChildClosureDeps,
): (args: OpenChildArgs) => Promise<OpenChildResult> {
  const now = deps.now ?? ((): number => Date.now());

  return async (args: OpenChildArgs): Promise<OpenChildResult> => {
    const ctx: OpenChildContext = {
      parentSessionId: deps.parentSessionId,
      parentDepth: deps.parentDepth,
      maxDepth: deps.maxDepth,
      parentModel: deps.currentParentModel(),
      activeToolNames: deps.currentToolNames(),
      registry: deps.registry,
      providerModelLookup: deps.providerModelLookup,
      now,
      runChild: ({ record, prompt }) => runChildWithLifecycle(record, prompt, deps),
    };
    return coreOpenChild(ctx, args);
  };
}

/**
 * Wraps the child-session execution with the lifecycle steps that the core
 * `openChild` does not handle directly: IP-Authority registration, audit
 * attribution, and child scope construction. Wiki: core/Subagent-Sessions.md
 * §Identity and lifecycle + §Cancellation cascade.
 */
async function runChildWithLifecycle(
  record: SubagentRecord,
  prompt: string,
  deps: OpenChildClosureDeps,
): Promise<OpenChildResult> {
  // Register with the IP Authority so out-of-envelope IP requests from this
  // child carry attribution and serialize via the comparator (D4a).
  deps.ipAuthority.registerSubagent({
    subagentId: record.subagentId,
    parentSessionId: record.parentSessionId,
    spawnedAt: record.spawnedAt,
  });

  // Build a child-session cancellation scope; cascades from parent session
  // scope per wiki/core/Subagent-Sessions.md §Cancellation cascade.
  const childScope = deps.parentSessionScope.child("child-session");

  try {
    return await runWithEnvelopePrompt(record, prompt, deps, childScope.signal);
  } finally {
    deps.ipAuthority.unregisterSubagent(record.subagentId);
    if (!childScope.signal.aborted) {
      childScope.cancel("parent");
    }
  }
}

/**
 * Raise the `approveSubagentEnvelope` IP request, then either run the child
 * (on approve) or surface a typed envelopeDenied result (on reject). Headless
 * without `--yolo` halts at the IP and surfaces `Subagent/HeadlessHalted`
 * via the IP Authority's halt path.
 */
async function runWithEnvelopePrompt(
  record: SubagentRecord,
  prompt: string,
  deps: OpenChildClosureDeps,
  signal: AbortSignal,
): Promise<OpenChildResult> {
  // The approval audit (via wrapChildAudit) stamps parentSessionId / depth /
  // subagentId onto whatever payload we hand `auditBus.emit`.
  const wrappedAudit = wrapChildAudit({
    emit: deps.auditBus.emit,
    record: {
      parentSessionId: record.parentSessionId,
      subagentId: record.subagentId,
      depth: record.depth,
    },
  });

  // Tool-trust auto-approve under interactive `--yolo` per wiki/runtime/
  // Headless-and-Interactor.md (1.1.0) §Tool-trust auto-approval.
  let approvalValue: string;
  if (deps.isYolo?.() === true) {
    approvalValue = "approve";
  } else {
    const promptText = formatEnvelopePrompt(record, prompt);
    try {
      // Raise the canonical `approveSubagentEnvelope` kind. The fallback
      // interactor (mount.tsx bindFallbackInteractor) and the Ink dialog
      // renderer both subscribe to InteractionRaised events with this kind.
      // Pass display attribution so the dialog renders the subagent chip
      // (depth, label) above the prompt text.
      // Race against the child scope's signal so a session-scope cancel
      // during a pending envelope IP aborts cleanly instead of hanging.
      const ipPromise = deps.ipAuthority.raiseWithSubagentContext(
        {
          kind: "approveSubagentEnvelope",
          prompt: promptText,
          options: ["approve", "deny"],
        },
        {
          subagentId: record.subagentId,
          parentSessionId: record.parentSessionId,
          depth: record.depth,
          ...(record.label !== undefined ? { subagentLabel: record.label } : {}),
          model: record.model,
          requestedEnvelope: record.approvedEnvelope,
          promptSummary: prompt.length <= 120 ? prompt : `${prompt.slice(0, 120)}…`,
        },
      );
      const result = await raceWithAbort(ipPromise, signal);
      approvalValue = result.value;
    } catch (err) {
      if (err instanceof Cancellation) {
        return { outcome: "aborted", subagentId: record.subagentId, reason: "parentCancel" };
      }
      // Headless without --yolo: structured haltStatus per wiki/runtime/
      // Headless-and-Interactor.md (1.1.0) §Subagent IP requests. The
      // correlationId on the haltStatus is the IP request's own UUID
      // (propagated from IpAuthority's runEntryAgainst), NOT the
      // subagentId — they're distinct identifiers.
      if (err instanceof Validation && err.context["code"] === "HeadlessInteractionRequired") {
        const correlationId =
          typeof err.context["requestId"] === "string"
            ? err.context["requestId"]
            : record.subagentId;
        return {
          outcome: "halted",
          subagentId: record.subagentId,
          haltStatus: {
            requestKind: "approveSubagentEnvelope",
            correlationId,
            subagentId: record.subagentId,
            decision: "halt",
            reason: "headless without --yolo",
          },
        };
      }
      wrappedAudit.emit("SubagentEnvelopeDenied", {
        kind: "SubagentEnvelopeDenied",
        reason: "interactor-error",
        requestedEnvelope: record.approvedEnvelope,
        model: record.model,
        ...(record.label !== undefined ? { label: record.label } : {}),
      });
      return { outcome: "aborted", subagentId: record.subagentId, reason: "envelopeDenied" };
    }
  }

  if (approvalValue !== "approve") {
    wrappedAudit.emit("SubagentEnvelopeDenied", {
      kind: "SubagentEnvelopeDenied",
      reason: "user-denied",
      requestedEnvelope: record.approvedEnvelope,
      model: record.model,
      ...(record.label !== undefined ? { label: record.label } : {}),
    });
    return { outcome: "aborted", subagentId: record.subagentId, reason: "envelopeDenied" };
  }

  wrappedAudit.emit("SubagentEnvelopeApproved", {
    kind: "SubagentEnvelopeApproved",
    requestedEnvelope: record.approvedEnvelope,
    approvedEnvelope: record.approvedEnvelope,
    model: record.model,
    ...(record.label !== undefined ? { label: record.label } : {}),
  });

  // Hand off to the runtime's child runner. Spawn / Completed / Halted /
  // Aborted audit emissions are the runner's responsibility.
  return deps.childRunner.run({ record, prompt, signal });
}

function formatEnvelopePrompt(record: SubagentRecord, prompt: string): string {
  const envelope =
    record.approvedEnvelope.length > 0 ? record.approvedEnvelope.join(", ") : "(none)";
  const label = record.label !== undefined ? ` "${record.label}"` : "";
  return [
    `Approve subagent envelope${label}?`,
    `  depth: ${String(record.depth)}`,
    `  model: ${record.model.providerId}/${record.model.modelId}`,
    `  envelope: ${envelope}`,
    `  prompt summary: ${truncate(prompt, 120)}`,
  ].join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Construct a permissive `ProviderModelLookup` from the parent's loaded tools
 * + active selection. Used for v1 wiring where the bundled `delegate` only
 * accepts the parent's providerId. Subsequent iterations can wire a stricter
 * lookup against the layered settings.json `providers` map.
 */
export function buildPermissiveProviderModelLookup(
  parentModel: () => { readonly providerId: string; readonly modelId: string },
): ProviderModelLookup {
  return {
    hasProvider(providerId) {
      return providerId === parentModel().providerId;
    },
    hasModel(_providerId, modelId) {
      return typeof modelId === "string" && modelId.length > 0;
    },
    satisfiesRequiredCapabilities() {
      return true;
    },
  };
}

/**
 * Race a Promise against an AbortSignal. When the signal aborts before the
 * promise resolves, throws a typed Cancellation so callers map it to
 * `parentCancel`. Used for IpAuthority raises that lack a native abort
 * surface (the fallback interactor and Ink dialog don't wire one in).
 */
async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new Cancellation("operation aborted before raise", undefined, {
      code: "TurnCancelled",
      reason: "session-cancel",
    });
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(
        new Cancellation("operation aborted while raise was pending", undefined, {
          code: "TurnCancelled",
          reason: "session-cancel",
        }),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Filter `loadedTools` down to those whose flat-name appears in the supplied
 * envelope. Used by the child runner to narrow the tool manifest the child
 * sees per wiki/core/Subagent-Sessions.md §Inheritance "Tools manifest".
 */
export function filterToolsByEnvelope(
  loadedTools: readonly LoadedTool[],
  envelope: readonly string[],
): readonly LoadedTool[] {
  const allow = new Set(envelope);
  return loadedTools.filter((tool) => allow.has(tool.name));
}
