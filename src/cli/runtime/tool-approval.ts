import { runApprovalStack } from "../../core/security/approval/stack.js";

import { appendAudit, nowIso, studHome } from "./storage.js";

import type { ToolContract } from "../../contracts/tools.js";
import type {
  ApprovalCacheEntry,
  ApprovalCacheKey,
  ApprovalCacheReadWrite,
} from "../../core/security/approval/cache.js";
import type { PromptIO } from "../prompt.js";
import type { LoadedTool, ResolvedShellDeps, SessionBootstrap } from "./types.js";

function approvalCacheKey(toolId: string, approvalKey: string): string {
  return `${toolId}:${approvalKey}`;
}

function displayApprovalKey(approvalKey: string): string {
  return approvalKey.length > 0 && approvalKey !== "." ? approvalKey : ".";
}

function splitPathApprovalKey(approvalKey: string): readonly string[] {
  if (approvalKey.length === 0 || approvalKey === ".") {
    return ["."];
  }
  return approvalKey.split("|").filter((part) => part.length > 0);
}

function pathApprovalCovers(approvedKey: string, requestedKey: string): boolean {
  return (
    approvedKey.length === 0 ||
    approvedKey === "." ||
    approvedKey === requestedKey ||
    requestedKey.startsWith(`${approvedKey}/`)
  );
}

function isPathApprovalCovered(
  approvedToolKeys: ReadonlySet<string>,
  toolId: string,
  requestedKey: string,
): boolean {
  const prefix = `${toolId}:`;
  for (const approvedCacheKey of approvedToolKeys) {
    if (!approvedCacheKey.startsWith(prefix)) {
      continue;
    }
    if (pathApprovalCovers(approvedCacheKey.slice(prefix.length), requestedKey)) {
      return true;
    }
  }
  return false;
}

function isToolApproved(
  tool: LoadedTool,
  approvalKey: string,
  approvedToolKeys: ReadonlySet<string>,
): boolean {
  if (tool.approvalScope === "exact") {
    return approvedToolKeys.has(approvalCacheKey(tool.id, approvalKey));
  }

  return splitPathApprovalKey(approvalKey).every((requestedKey) =>
    isPathApprovalCovered(approvedToolKeys, tool.id, requestedKey),
  );
}

function rememberToolApproval(
  tool: LoadedTool,
  approvalKey: string,
  approvedToolKeys: Map<string, ApprovalCacheEntry>,
): void {
  const keys =
    tool.approvalScope === "path-set" ? splitPathApprovalKey(approvalKey) : [approvalKey];
  for (const pathKey of keys) {
    const key = { toolId: tool.id, approvalKey: pathKey };
    approvedToolKeys.set(approvalCacheKey(tool.id, pathKey), {
      key,
      grantedAt: new Date().toISOString(),
      grantedBy: "user",
      scope: "session",
    });
  }
}

function createRuntimeApprovalCache(tools: readonly LoadedTool[]): ApprovalCacheReadWrite {
  const entries = new Map<string, ApprovalCacheEntry>();
  const toolsById = new Map(tools.map((tool) => [tool.id, tool] as const));
  return {
    has(key: ApprovalCacheKey): boolean {
      const tool = toolsById.get(key.toolId);
      return tool === undefined
        ? entries.has(approvalCacheKey(key.toolId, key.approvalKey))
        : isToolApproved(tool, key.approvalKey, new Set(entries.keys()));
    },
    get(key: ApprovalCacheKey): ApprovalCacheEntry | undefined {
      return entries.get(approvalCacheKey(key.toolId, key.approvalKey));
    },
    add(entry: ApprovalCacheEntry): Promise<void> {
      const tool = toolsById.get(entry.key.toolId);
      if (tool === undefined) {
        entries.set(approvalCacheKey(entry.key.toolId, entry.key.approvalKey), entry);
      } else {
        rememberToolApproval(tool, entry.key.approvalKey, entries);
      }
      return Promise.resolve();
    },
    clear(): Promise<void> {
      entries.clear();
      return Promise.resolve();
    },
  };
}

function toApprovalToolContract(tool: LoadedTool, workspaceRoot: string): ToolContract {
  return {
    kind: "Tool",
    contractVersion: "1.0.0",
    requiredCoreVersion: ">=1.0.0 <2.0.0",
    lifecycle: {},
    configSchema: { type: "object", additionalProperties: true },
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "tools", manifestKey: tool.id },
    reloadBehavior: "between-turns",
    inputSchema: tool.parameters,
    outputSchema: { type: "object" },
    execute: () => Promise.resolve({ ok: true, value: {} }),
    gated: tool.gated,
    deriveApprovalKey(args: unknown): string {
      const key = tool.deriveApprovalKey(args, workspaceRoot);
      return key.length > 0 ? key : ".";
    },
  };
}

export async function ensureToolApproval(args: {
  readonly session: SessionBootstrap;
  readonly prompt: PromptIO;
  readonly tool: LoadedTool;
  readonly callArgs: unknown;
  readonly workspaceRoot: string;
  readonly cache: ApprovalCacheReadWrite;
  readonly deps: ResolvedShellDeps;
}): Promise<boolean> {
  if (!args.tool.gated) {
    return true;
  }

  const decision = await runApprovalStack({
    toolId: args.tool.id,
    args: args.callArgs,
    tool: toApprovalToolContract(args.tool, args.workspaceRoot),
    sm: null,
    stageExecutionId: null,
    attempt: 1,
    proposalId: `${args.tool.id}:${Date.now().toString()}`,
    mode: {
      mode:
        args.session.securityMode === "yolo" || args.session.yolo
          ? "yolo"
          : args.session.securityMode,
      allowlist: [],
      setAt: nowIso(args.deps),
    },
    cache: args.cache,
    raiseApproval: async ({ toolId, approvalKey }) => {
      const approved = await args.prompt.select(
        `Allow tool '${toolId}' for '${displayApprovalKey(approvalKey)}'?`,
        [
          { value: "approve", label: "approve and remember for this session" },
          { value: "deny", label: "deny" },
        ] as const,
      );
      return approved === "approve" ? { kind: "approve" } : { kind: "deny" };
    },
    guardHooks: [],
    audit: {
      write(record) {
        return appendAudit(studHome(args.deps.homedir()), {
          type: "Approval",
          at: nowIso(args.deps),
          ...record,
        });
      },
    },
  });

  return decision.kind === "approve";
}

export function createApprovalCache(tools: readonly LoadedTool[]): ApprovalCacheReadWrite {
  return createRuntimeApprovalCache(tools);
}
