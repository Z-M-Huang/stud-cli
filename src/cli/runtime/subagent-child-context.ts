/**
 * Per-child-session context builders extracted from `subagent-child-runner.ts`
 * to keep that file under the per-file line limit. Each helper produces a
 * piece of the child's runtime: a depth-aware host, an attribution-stamped
 * audit bus, a synthetic SessionBootstrap that overrides the modelId, and
 * the IpAuthority-routed request-approval callback.
 *
 * Wiki: core/Subagent-Sessions.md §Identity and lifecycle +
 * core/Event-Bus.md (1.2.0) §Events from inside a child session +
 * security/Tool-Approvals.md (1.1.0) §Subagent envelope and child-session
 * approvals.
 */

import { HOST_UNWRAP } from "../../core/host/host-api.js";

import { createActiveSelectionHolder } from "./active-selection.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { IpAuthority } from "./ip-authority.js";
import type { ProviderSelection, SessionBootstrap } from "./types.js";
import type { SubagentRecord } from "../../contracts/subagent.js";
import type { OpenChildArgs, OpenChildResult } from "../../core/host/api/session.js";
import type { HostAPI } from "../../core/host/host-api.js";

/**
 * Build a child-scoped host that wraps the parent host with:
 *   1. depth-aware `session.openChild` (so nested delegation enforces the
 *      depth cap correctly), and
 *   2. attribution-stamping `events.emit` (so every ToolInvocation* /
 *      ProviderRequest* / SessionTurn* event emitted from the child's
 *      turn loop carries `parentSessionId` + `subagentId` + `depth` in
 *      its payload). Wiki: core/Event-Bus.md (1.2.0) §Events from inside
 *      a child session.
 */
export function buildChildHost(
  parentHost: HostAPI,
  record: SubagentRecord,
  buildChildOpenChild:
    | ((parentDepth: number) => (args: OpenChildArgs) => Promise<OpenChildResult>)
    | undefined,
): HostAPI {
  const childOpenChild = buildChildOpenChild?.(record.depth);
  const attribution = {
    parentSessionId: record.parentSessionId,
    subagentId: record.subagentId,
    depth: record.depth,
  };
  // Tag the wrapper with HOST_UNWRAP pointing back at the parent so
  // WeakMap-keyed-by-host state (e.g. each provider's `configsByHost`)
  // resolves through the wrapper. Without this, the child session's
  // first provider call throws `ExtensionHost/LifecycleFailure: provider
  // has not been initialized` because the WeakMap was set against the
  // parent's reference but `configForHost(childHost)` is a miss.
  const wrapped = {
    ...parentHost,
    session: {
      ...parentHost.session,
      ...(childOpenChild !== undefined ? { openChild: (args) => childOpenChild(args) } : {}),
    },
    events: {
      on: (name, handler) => parentHost.events.on(name, handler),
      off: (name, handler) => parentHost.events.off(name, handler),
      emit: (name, payload) => {
        const stamped: Readonly<Record<string, unknown>> =
          typeof payload === "object" && payload !== null
            ? { ...(payload as Record<string, unknown>), ...attribution }
            : { value: payload, ...attribution };
        parentHost.events.emit(name, stamped);
      },
    },
  } as HostAPI & { [HOST_UNWRAP]?: HostAPI };
  wrapped[HOST_UNWRAP] = parentHost;
  return wrapped;
}

/**
 * Wrap the parent's SessionAuditBus so child-emitted records carry
 * attribution automatically. The remaining surface (bus, withTurn, query,
 * activeSubagents, close) shares the parent's identity — the child does
 * not own its own JSONL writer or correlation context.
 */
export function wrapAuditBusForChild(
  parent: SessionAuditBus,
  record: SubagentRecord,
): SessionAuditBus {
  return {
    bus: parent.bus,
    emit: (kind, payload) =>
      parent.emit(kind, {
        ...payload,
        parentSessionId: record.parentSessionId,
        subagentId: record.subagentId,
        depth: record.depth,
      }),
    withTurn: parent.withTurn,
    query: parent.query,
    activeSubagents: parent.activeSubagents,
    close: () => Promise.resolve(),
  };
}

/**
 * Build a synthetic SessionBootstrap whose `selection.current()` returns
 * the parent's currently-active provider entry but with the child's
 * modelId override applied. The entry id and protocol stay parent-side
 * because the child reuses the parent's RuntimeContext (cross-provider
 * override is a v1 limitation; same-provider modelId override flows
 * through here).
 */
export function buildChildSession(
  parent: SessionBootstrap,
  record: SubagentRecord,
): SessionBootstrap {
  const parentSel = parent.selection.current();
  const childSelection: ProviderSelection = {
    entryId: parentSel.entryId,
    protocolId: parentSel.protocolId,
    config: parentSel.config,
    modelId: record.model.modelId,
  };
  const childHolder = createActiveSelectionHolder(childSelection);
  return {
    sessionId: record.subagentId,
    continuationMaxIterations: parent.continuationMaxIterations,
    selection: childHolder,
    projectRoot: parent.projectRoot,
    projectTrusted: parent.projectTrusted,
    securityMode: parent.securityMode,
    manifest: parent.manifest,
    resumed: false,
    yolo: parent.yolo,
    paramsStore: parent.paramsStore,
  };
}

/**
 * Build a `requestApproval` callback that routes through the parent-session
 * IpAuthority's `raiseFromSubagent`. The IP request carries subagent
 * attribution on the dialog chip, serializes against other parent-session
 * IPs, and respects the cross-subagent comparator (D4a). On user accept
 * returns "approve"; on reject returns "deny"; rethrows
 * `Validation/HeadlessInteractionRequired` so the caller can surface a
 * structured haltStatus.
 */
export function buildSubagentRequestApproval(
  ipAuthority: IpAuthority,
  record: SubagentRecord,
): (request: {
  toolId: string;
  approvalKey: string;
  displayApprovalKey: string;
}) => Promise<"approve" | "deny"> {
  return async (request) => {
    const result = await ipAuthority.raiseFromSubagent(record.subagentId, {
      kind: "select",
      prompt: `Allow tool '${request.toolId}' for '${request.displayApprovalKey}'? (subagent ${record.subagentId.slice(0, 8)})`,
      options: ["approve", "deny"],
    });
    return result.value === "approve" ? "approve" : "deny";
  };
}
