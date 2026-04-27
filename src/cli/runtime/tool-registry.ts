import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, dirname } from "node:path";

import { createAskUser } from "agentool/ask-user";
import { createBash } from "agentool/bash";
import { createDiff } from "agentool/diff";
import { createEdit } from "agentool/edit";
import { createGlob } from "agentool/glob";
import { createGrep } from "agentool/grep";
import { createHttpRequest } from "agentool/http-request";
import { createLsp } from "agentool/lsp";
import { createMemory } from "agentool/memory";
import { createMultiEdit } from "agentool/multi-edit";
import { createRead } from "agentool/read";
import { createSleep } from "agentool/sleep";
import { createToolSearch } from "agentool/tool-search";
import { createWebFetch } from "agentool/web-fetch";
import { createWebSearch } from "agentool/web-search";
import { createWrite } from "agentool/write";
import { asSchema } from "ai";

import { ToolTerminal } from "../../core/errors/index.js";

import { studHome } from "./storage.js";
import { coerceBashArgs } from "./tool-arg-coercion.js";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_WEB_CONTENT_BYTES,
  type AgentoolLike,
  type LoadedTool,
  type ResolvedShellDeps,
  type RuntimeToolResult,
  type SessionBootstrap,
} from "./types.js";

import type { ProviderToolDefinition } from "../../contracts/providers.js";
import type { PromptIO } from "../prompt.js";

interface ArgRecordResult {
  readonly ok: boolean;
  readonly value?: Record<string, unknown>;
  readonly error?: ToolTerminal;
}

type PathScope = "directory" | "parent";

function argsRecord(toolId: string, args: unknown): ArgRecordResult {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    return { ok: true, value: { ...(args as Record<string, unknown>) } };
  }
  return {
    ok: false,
    error: new ToolTerminal(`tool '${toolId}' requires object arguments`, undefined, {
      code: "InputInvalid",
      toolId,
    }),
  };
}

function resolveToolPath(inputPath: string, workspaceRoot: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(workspaceRoot, trimmed);
}

function relativeWorkspacePath(targetPath: string, workspaceRoot: string): string | null {
  const relPath = relative(resolve(workspaceRoot), resolve(targetPath));
  if (relPath.length === 0) {
    return "";
  }
  if (
    relPath === ".." ||
    relPath.startsWith("../") ||
    relPath.startsWith("..\\") ||
    isAbsolute(relPath)
  ) {
    return null;
  }
  return relPath.replace(/\\/gu, "/");
}

function scopedPathApprovalKey(
  targetPath: string,
  workspaceRoot: string,
  scope: PathScope,
): string {
  const relPath = relativeWorkspacePath(targetPath, workspaceRoot);
  if (relPath === null || relPath.length === 0) {
    return "";
  }
  if (scope === "directory") {
    return relPath;
  }

  const parts = relPath.split("/");
  parts.pop();
  return parts.join("/");
}

function deriveCommandPrefix(command: string): string {
  for (const token of command.trim().split(/\s+/u)) {
    if (token.length === 0 || /^[a-z_]\w*=/iu.test(token) || /^\d*[<>&]/u.test(token)) {
      continue;
    }
    return token;
  }
  return "";
}

function urlApprovalKey(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function normalizePathKeys(
  toolId: string,
  args: unknown,
  workspaceRoot: string,
  keys: readonly string[],
): RuntimeToolResult {
  const record = argsRecord(toolId, args);
  if (!record.ok) {
    return { ok: false, error: record.error! };
  }

  const normalized = { ...record.value! };
  for (const key of keys) {
    const rawValue = normalized[key];
    if (rawValue === undefined) {
      continue;
    }
    if (typeof rawValue !== "string") {
      return toolResultError(toolId, `tool '${toolId}' expected '${key}' to be a string`, { key });
    }

    const absolutePath = resolveToolPath(rawValue, workspaceRoot);
    if (relativeWorkspacePath(absolutePath, workspaceRoot) === null) {
      return toolResultError(toolId, `tool '${toolId}' cannot access paths outside the workspace`, {
        key,
        path: rawValue,
        workspaceRoot,
      });
    }
    normalized[key] = absolutePath;
  }
  return { ok: true, value: normalized };
}

function passthroughArgs(toolId: string, args: unknown): RuntimeToolResult {
  const record = argsRecord(toolId, args);
  return record.ok ? { ok: true, value: record.value! } : { ok: false, error: record.error! };
}

async function loadAgentoolTool(options: {
  readonly id: string;
  readonly tool: AgentoolLike;
  readonly gated: boolean;
  readonly approvalScope: LoadedTool["approvalScope"];
  readonly prepareArgs?: ((args: unknown) => unknown) | undefined;
  readonly normalizeArgs: LoadedTool["normalizeArgs"];
  readonly deriveApprovalKey: LoadedTool["deriveApprovalKey"];
}): Promise<LoadedTool> {
  const schema = asSchema(options.tool.inputSchema);
  return {
    id: options.id,
    name: options.id,
    description: options.tool.description ?? `${options.id} tool`,
    parameters: (await schema.jsonSchema) as ProviderToolDefinition["parameters"],
    async validateArgs(args: unknown) {
      if (schema.validate === undefined) {
        return { ok: true, value: args };
      }
      const result = await schema.validate(options.prepareArgs?.(args) ?? args);
      return result.success
        ? { ok: true, value: result.value }
        : { ok: false, errors: { message: result.error.message } };
    },
    normalizeArgs: options.normalizeArgs,
    deriveApprovalKey: options.deriveApprovalKey,
    async execute(args: unknown, toolCallId: string) {
      if (typeof options.tool.execute !== "function") {
        return {
          ok: false,
          error: new ToolTerminal(`tool '${options.id}' is not executable`, undefined, {
            code: "ToolExecutionFailed",
            toolId: options.id,
          }),
        };
      }

      try {
        const execute = options.tool.execute as (
          callArgs: unknown,
          callOptions: { readonly toolCallId: string; readonly messages: readonly unknown[] },
        ) => unknown;
        return {
          ok: true,
          value: await Promise.resolve(execute(args, { toolCallId, messages: [] })),
        };
      } catch (error) {
        return {
          ok: false,
          error: new ToolTerminal(`tool '${options.id}' execution failed`, error, {
            code: "ToolExecutionFailed",
            toolId: options.id,
          }),
        };
      }
    },
    gated: options.gated,
    approvalScope: options.approvalScope,
  };
}

function loadPathScopedTool(options: {
  readonly id: string;
  readonly tool: AgentoolLike;
  readonly pathKeys: readonly string[];
  readonly scope: PathScope;
  readonly gated?: boolean;
}): Promise<LoadedTool> {
  return loadAgentoolTool({
    id: options.id,
    tool: options.tool,
    gated: options.gated ?? true,
    approvalScope: "path",
    normalizeArgs(args, workspaceRoot) {
      return normalizePathKeys(options.id, args, workspaceRoot, options.pathKeys);
    },
    deriveApprovalKey(args, workspaceRoot) {
      const record = argsRecord(options.id, args);
      const path = record.ok ? record.value?.[options.pathKeys[0]!] : undefined;
      return typeof path === "string"
        ? scopedPathApprovalKey(path, workspaceRoot, options.scope)
        : "";
    },
  });
}

function loadUrlScopedTool(id: string, tool: AgentoolLike): Promise<LoadedTool> {
  return loadAgentoolTool({
    id,
    tool,
    gated: true,
    approvalScope: "exact",
    normalizeArgs(args) {
      return passthroughArgs(id, args);
    },
    deriveApprovalKey(args) {
      const record = argsRecord(id, args);
      return urlApprovalKey(record.ok ? record.value?.["url"] : undefined);
    },
  });
}

function loadPlainTool(
  id: string,
  tool: AgentoolLike,
  gated: boolean,
  deriveApprovalKey: LoadedTool["deriveApprovalKey"],
  prepareArgs?: (args: unknown) => unknown,
): Promise<LoadedTool> {
  return loadAgentoolTool({
    id,
    tool,
    gated,
    approvalScope: "exact",
    prepareArgs,
    normalizeArgs(args) {
      return passthroughArgs(id, args);
    },
    deriveApprovalKey,
  });
}

function workspaceRoot(session: SessionBootstrap, deps: ResolvedShellDeps): string {
  return session.projectTrusted ? dirname(session.projectRoot) : studHome(deps.homedir());
}

function filesystemToolPromises(root: string): readonly Promise<LoadedTool>[] {
  return [
    loadPlainTool(
      "bash",
      createBash({ cwd: root, timeout: DEFAULT_TOOL_TIMEOUT_MS }),
      true,
      (args) => {
        const record = argsRecord("bash", args);
        return typeof record.value?.["command"] === "string"
          ? deriveCommandPrefix(record.value["command"])
          : "";
      },
      coerceBashArgs,
    ),
    loadPathScopedTool({
      id: "glob",
      tool: createGlob({ cwd: root }),
      pathKeys: ["path"],
      scope: "directory",
    }),
    loadPathScopedTool({
      id: "grep",
      tool: createGrep({ cwd: root }),
      pathKeys: ["path"],
      scope: "directory",
    }),
    loadPathScopedTool({
      id: "read",
      tool: createRead({ cwd: root }),
      pathKeys: ["file_path"],
      scope: "parent",
      gated: false,
    }),
    loadPathScopedTool({
      id: "edit",
      tool: createEdit({ cwd: root }),
      pathKeys: ["file_path"],
      scope: "parent",
    }),
    loadPathScopedTool({
      id: "write",
      tool: createWrite({ cwd: root }),
      pathKeys: ["file_path"],
      scope: "parent",
    }),
    loadPathScopedTool({
      id: "multi-edit",
      tool: createMultiEdit({ cwd: root }),
      pathKeys: ["file_path"],
      scope: "parent",
    }),
    loadAgentoolTool({
      id: "diff",
      tool: createDiff({ cwd: root }),
      gated: true,
      approvalScope: "path-set",
      normalizeArgs(args, currentWorkspaceRoot) {
        return normalizePathKeys("diff", args, currentWorkspaceRoot, [
          "file_path",
          "other_file_path",
        ]);
      },
      deriveApprovalKey(args, currentWorkspaceRoot) {
        const record = argsRecord("diff", args);
        const paths = ["file_path", "other_file_path"]
          .map((key) => (record.ok ? record.value?.[key] : undefined))
          .filter((value): value is string => typeof value === "string");
        return paths.length === 0
          ? "content"
          : [
              ...new Set(
                paths.map((path) => scopedPathApprovalKey(path, currentWorkspaceRoot, "parent")),
              ),
            ]
              .sort()
              .join("|");
      },
    }),
    loadPathScopedTool({
      id: "lsp",
      tool: createLsp({ cwd: root }),
      pathKeys: ["filePath"],
      scope: "parent",
    }),
  ];
}

function integrationToolPromises(
  root: string,
  deps: ResolvedShellDeps,
): readonly Promise<LoadedTool>[] {
  return [
    loadUrlScopedTool(
      "web-fetch",
      createWebFetch({
        timeout: DEFAULT_TOOL_TIMEOUT_MS,
        maxContentLength: DEFAULT_WEB_CONTENT_BYTES,
        userAgent: `stud-cli/${deps.packageVersion}`,
      }),
    ),
    loadUrlScopedTool("http-request", createHttpRequest({ timeout: DEFAULT_TOOL_TIMEOUT_MS })),
    loadPlainTool(
      "memory",
      createMemory({ cwd: root, memoryDir: join(studHome(deps.homedir()), "memory") }),
      true,
      (args) => {
        const record = argsRecord("memory", args);
        const action =
          typeof record.value?.["action"] === "string" ? record.value["action"] : "memory";
        const key = typeof record.value?.["key"] === "string" ? record.value["key"] : "";
        return key.length > 0 ? `${action}:${key}` : action;
      },
    ),
    loadPlainTool("sleep", createSleep(), false, () => "sleep"),
    loadPlainTool(
      "web-search",
      createWebSearch({
        onSearch() {
          return Promise.resolve(
            "Error [web-search]: No web-search backend is configured in stud-cli yet.",
          );
        },
      }),
      true,
      () => "web-search",
    ),
  ];
}

function interactionToolPromises(
  prompt: PromptIO,
  toolRegistry: Record<string, { description: string }>,
): readonly Promise<LoadedTool>[] {
  return [
    loadPlainTool(
      "tool-search",
      createToolSearch({ tools: toolRegistry }),
      false,
      () => "tool-registry",
    ),
    loadPlainTool(
      "ask-user",
      createAskUser({
        onQuestion(question, options) {
          const trimmed = (options ?? []).filter((option) => option.trim().length > 0);
          return trimmed.length > 0 && new Set(trimmed).size === trimmed.length
            ? prompt.select(
                question,
                trimmed.map((option) => ({ value: option, label: option })),
              )
            : prompt.input(question);
        },
      }),
      true,
      () => "interactive",
    ),
  ];
}

export function sessionWorkspaceRoot(session: SessionBootstrap, deps: ResolvedShellDeps): string {
  return workspaceRoot(session, deps);
}

export async function initializeBundledTools(
  session: SessionBootstrap,
  deps: ResolvedShellDeps,
  prompt: PromptIO,
): Promise<readonly LoadedTool[]> {
  const root = workspaceRoot(session, deps);
  const toolRegistry: Record<string, { description: string }> = {};
  const loaded = await Promise.all([
    ...filesystemToolPromises(root),
    ...integrationToolPromises(root, deps),
    ...interactionToolPromises(prompt, toolRegistry),
  ]);
  loaded.forEach((tool) => {
    toolRegistry[tool.name] = { description: tool.description };
  });
  return loaded;
}

export async function disposeBundledTools(): Promise<void> {
  return Promise.resolve();
}

export function providerToolDefinitions(
  tools: readonly LoadedTool[],
): readonly ProviderToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function toolResultError(
  toolId: string,
  message: string,
  context: Record<string, unknown>,
): RuntimeToolResult {
  return {
    ok: false,
    error: new ToolTerminal(message, undefined, {
      code: "InputInvalid",
      toolId,
      ...context,
    }),
  };
}
