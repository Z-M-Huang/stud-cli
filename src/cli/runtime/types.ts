import { contract as anthropicContract } from "../../extensions/providers/anthropic/index.js";
import { contract as cliWrapperContract } from "../../extensions/providers/cli-wrapper/index.js";
import { contract as geminiContract } from "../../extensions/providers/gemini/index.js";
import { contract as openaiCompatibleContract } from "../../extensions/providers/openai-compatible/index.js";

import type { ActiveSelectionHolder } from "./active-selection.js";
import type { ParamsRuntimeStore } from "./params-runtime.js";
import type { ProviderContract, ProviderToolDefinition } from "../../contracts/providers.js";
import type { SessionManifest } from "../../contracts/session-store.js";
import type { SecurityMode, Settings as ContractSettings } from "../../contracts/settings-shape.js";
import type { ToolTerminal } from "../../core/errors/index.js";
import type { HostAPI } from "../../core/host/host-api.js";
import type { Settings as CoreSettings } from "../../core/settings/shape.js";
import type { ProviderModelLookup } from "../../core/subagent/spawn.js";
import type { AnthropicConfig } from "../../extensions/providers/anthropic/config.schema.js";
import type { CLIWrapperConfig } from "../../extensions/providers/cli-wrapper/config.schema.js";
import type { GeminiConfig } from "../../extensions/providers/gemini/config.schema.js";
import type { OpenAICompatibleConfig } from "../../extensions/providers/openai-compatible/config.schema.js";
import type { PromptIO } from "../prompt.js";
import type { asSchema } from "ai";

export type Settings = CoreSettings & ContractSettings;

/**
 * The user-chosen map key for one entry under `settings.json.providers.<id>`.
 * Open string — typically the backend's name (e.g., `"bailian"`, `"openai-prod"`).
 * Two entries may share `protocol`; their entry ids are still distinct.
 */
export type ProviderEntryId = string;

/**
 * The closed set of bundled protocol adapters. Each provider entry's
 * `protocol` field selects one of these. Third-party providers may add their
 * own protocol keys via a custom Provider extension; this type covers the
 * bundled four only.
 */
export type ProviderProtocolId = "anthropic" | "cli-wrapper" | "gemini" | "openai-compatible";

export type AuthPath =
  | "none"
  | "env-api-key"
  | "literal-api-key"
  | "auth-device-code"
  | "auth-password";
export type AnyProviderConfig =
  | AnthropicConfig
  | CLIWrapperConfig
  | GeminiConfig
  | OpenAICompatibleConfig;
export type RuntimeToolResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: ToolTerminal };

export interface AgentoolLike {
  readonly description?: string | undefined;
  readonly inputSchema: Parameters<typeof asSchema>[0];
  readonly execute?: unknown;
}

/**
 * Runtime audit record shape — one of three audit shapes in the codebase
 * (the others are `core/observability/audit/classes.ts:AuditRecord<K>` and
 * `core/host/api/audit.ts:AuditRecord`). All three carry the optional
 * `parentSessionId`, `subagentId`, `depth` attribution fields per
 * wiki/operations/Audit-Trail.md (1.2.0) §AuditRecord fields, populated on
 * every record emitted from a subagent child session.
 */
export interface AuditRecord {
  readonly type: string;
  readonly at: string;
  readonly parentSessionId?: string;
  readonly subagentId?: string;
  readonly depth?: number;
  readonly [key: string]: unknown;
}

export interface SecretRefKeyring {
  readonly kind: "keyring";
  readonly name: string;
}

export interface SecretStoreDocument {
  readonly entries: Readonly<Record<string, string>>;
}

export interface ProviderDescriptor {
  readonly protocolId: ProviderProtocolId;
  readonly label: string;
  readonly defaultModels: readonly [string, ...string[]];
  readonly defaultEnvName?: string;
  readonly defaultBaseURL?: string;
  readonly contract: ProviderContract<unknown>;
}

export interface ProviderSelection {
  readonly entryId: ProviderEntryId;
  readonly protocolId: ProviderProtocolId;
  readonly config: AnyProviderConfig;
  readonly modelId: string;
}

export interface LoadedTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: ProviderToolDefinition["parameters"];
  validateArgs(
    args: unknown,
  ): Promise<
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly errors: unknown }
  >;
  normalizeArgs(args: unknown, workspaceRoot: string): RuntimeToolResult;
  deriveApprovalKey(args: unknown, workspaceRoot: string): string;
  execute(args: unknown, toolCallId: string): Promise<RuntimeToolResult>;
  readonly gated: boolean;
  readonly approvalScope: "exact" | "path" | "path-set";
  /**
   * Optional preflight validator. Runs **before** `ensureToolApproval` and
   * **before** `deriveApprovalKey` (so the validator's `canonicalArgs` shape
   * what the approval-key sees). Most tools register no preflight — the
   * resolver treats absence as `{ ok: true, canonicalArgs: args }`.
   *
   * The bundled `delegate` tool uses preflight to (1) reject invalid spawns
   * before any IP fires (depth, model, envelope) and (2) canonicalize the
   * resolved `(providerId, modelId)` into `args.model` so `deriveApprovalKey`
   * stays pure-of-args per `contracts/Tools.md` §`deriveApprovalKey`. Wiki:
   * reference-extensions/tools/Delegate-Tool.md §Validation order.
   */
  preflight?(args: unknown, ctx: ToolPreflightContext): Promise<ToolPreflightResult>;
  /**
   * Optional executor that receives a session-scoped `HostAPI`. The runtime
   * resolver prefers `executeWithHost` when present; otherwise falls back to
   * `execute(args, toolCallId)`. Bundled in-tree tools that integrate with
   * core's host machinery (e.g., `delegate`'s `host.session.openChild`) use
   * this overload. Existing agentool-sourced tools remain unchanged.
   */
  executeWithHost?(
    args: unknown,
    toolCallId: string,
    host: HostAPI,
    signal: AbortSignal,
  ): Promise<RuntimeToolResult>;
}

/**
 * Context passed to a tool's optional `preflight` validator. Carries the
 * minimal session-shaped data the validator needs to canonicalize args and
 * reject invalid invocations before any approval prompt fires.
 *
 * Currently used only by the bundled `delegate` tool (Phase F of the
 * subagent implementation per
 * /home/ubuntu/.claude/plans/ultrathink-we-have-a-magical-gem.md).
 */
export interface ToolPreflightContext {
  readonly host: HostAPI;
  /** Current session's depth in the delegation chain (0 = orchestrator). */
  readonly currentDepth: number;
  /** Active provider/model on the current session — the inherited fallback. */
  readonly parentProviderId: string;
  readonly parentModelId: string;
  /** Currently-active tool manifest (flat names) for envelope subset checks. */
  readonly activeToolNames: readonly string[];
  /**
   * Provider/model lookup for delegate's model-validation preflight (D15).
   * When omitted, the bundled `delegate` falls back to a permissive
   * parent-only lookup. The runtime supplies a settings-backed lookup so
   * cross-provider overrides validate correctly.
   */
  readonly providerModelLookup?: ProviderModelLookup;
  /**
   * Resolved `delegate.maxDepth` from layered settings (or default). Used
   * by delegate's preflight to enforce the depth cap before any IP fires.
   */
  readonly maxDepth?: number;
}

/**
 * Result of a tool's optional `preflight` validator.
 *
 * On `ok: true`, the resolver continues with `canonicalArgs` — this becomes
 * the input to `deriveApprovalKey`, `ensureToolApproval`, and the executor.
 * On `denied`, the resolver short-circuits with a typed `ToolTerminal` error
 * — **no IP fires** in this branch (depth/envelope/model rejections never
 * prompt the user per the wiki's "no IP fires on validation failure" rule).
 * On `earlyReturn`, the resolver short-circuits with a SUCCESSFUL tool
 * result whose value is the supplied payload — used by tools like `delegate`
 * whose contract surfaces typed-aborted shapes (`{aborted: ...}`) as a
 * normal tool return rather than a tool error. **No IP fires** here either.
 */
export type ToolPreflightResult =
  | { readonly ok: true; readonly canonicalArgs: unknown }
  | { readonly denied: ToolTerminal }
  | { readonly earlyReturn: unknown };

export interface SessionBootstrap {
  readonly sessionId: string;
  readonly selection: ActiveSelectionHolder;
  readonly projectRoot: string;
  readonly projectTrusted: boolean;
  readonly securityMode: SecurityMode;
  readonly manifest: SessionManifest;
  readonly resumed: boolean;
  readonly yolo: boolean;
  /**
   * Provenance-preserving runtime params store. Holds the merged effective
   * view of `defaultParams ← --param ← /params` per
   * `wiki/contracts/Provider-Params.md` § "Merge layers — precedence". The
   * store outlives `/provider` swaps; only the `defaultParams` layer is
   * replaced when the active entry changes.
   */
  readonly paramsStore: ParamsRuntimeStore;
  /**
   * Prior-session runtime overrides scanned from the audit log at resume.
   * Populated only when `resumed === true` AND the prior session had
   * `--param` / `/params` mutations. The session-loop emits one
   * `RuntimeParamsNotResumed` event + `Params`-class audit record per
   * affected path right after the audit bus starts. Per
   * `wiki/flows/Session-Resume.md` § "Provider params not persisted".
   */
  readonly priorRuntimeOverrides?: readonly {
    readonly paramPath: readonly string[];
    readonly sourceLayer: "launch" | "/params";
    readonly redactedValue: unknown;
  }[];
}

export type ProjectTrustOutcome = "aborted" | "declined" | "not-applicable" | "trusted";

export interface ShellDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly homedir?: () => string;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly prompt?: PromptIO;
  readonly packageVersion?: string;
  readonly now?: () => Date;
  readonly sessionIdFactory?: () => string;
  readonly runSession?: (
    session: SessionBootstrap,
    deps: ResolvedShellDeps,
    prompt: PromptIO,
  ) => Promise<void>;
}

export interface ResolvedShellDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly homedir: () => string;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly packageVersion: string;
  readonly now: () => Date;
  readonly sessionIdFactory: () => string;
  readonly runSession: (
    session: SessionBootstrap,
    deps: ResolvedShellDeps,
    prompt: PromptIO,
  ) => Promise<void>;
}

export type SecretsHost = HostAPI & {
  readonly secrets?: {
    resolve(ref: { readonly kind: "env" | "keyring"; readonly name: string }): Promise<string>;
  };
};

/**
 * The bundled protocol descriptors, keyed by `ProviderProtocolId`. Provider
 * **entries** in `settings.json.providers` are user-keyed and may multiply
 * (two `openai-compatible` entries differing in `baseURL`); this table indexes
 * the closed set of *protocol adapters* the entries dispatch to via their
 * `protocol` field.
 */
export const PROTOCOLS: Record<ProviderProtocolId, ProviderDescriptor> = {
  anthropic: {
    protocolId: "anthropic",
    label: "anthropic",
    defaultModels: ["claude-opus-4-7"],
    defaultEnvName: "ANTHROPIC_API_KEY",
    defaultBaseURL: "https://api.anthropic.com",
    contract: anthropicContract as unknown as ProviderContract<unknown>,
  },
  "cli-wrapper": {
    protocolId: "cli-wrapper",
    label: "cli-wrapper (local subscription/test double)",
    defaultModels: ["reference-model"],
    contract: cliWrapperContract as unknown as ProviderContract<unknown>,
  },
  gemini: {
    protocolId: "gemini",
    label: "gemini",
    defaultModels: ["gemini-2.0-flash"],
    defaultEnvName: "GEMINI_API_KEY",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    contract: geminiContract as unknown as ProviderContract<unknown>,
  },
  "openai-compatible": {
    protocolId: "openai-compatible",
    label: "openai-compatible",
    defaultModels: ["gpt-4o"],
    defaultEnvName: "OPENAI_API_KEY",
    defaultBaseURL: "https://api.openai.com/v1",
    contract: openaiCompatibleContract as unknown as ProviderContract<unknown>,
  },
};

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_WEB_CONTENT_BYTES = 5 * 1024 * 1024;
export const TOOL_CALL_CONTINUATION_LIMIT = 12;
