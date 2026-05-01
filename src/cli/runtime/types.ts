import { contract as anthropicContract } from "../../extensions/providers/anthropic/index.js";
import { contract as cliWrapperContract } from "../../extensions/providers/cli-wrapper/index.js";
import { contract as geminiContract } from "../../extensions/providers/gemini/index.js";
import { contract as openaiCompatibleContract } from "../../extensions/providers/openai-compatible/index.js";

import type { ActiveSelectionHolder } from "./active-selection.js";
import type { ProviderContract, ProviderToolDefinition } from "../../contracts/providers.js";
import type { SessionManifest } from "../../contracts/session-store.js";
import type { SecurityMode, Settings as ContractSettings } from "../../contracts/settings-shape.js";
import type { ToolTerminal } from "../../core/errors/index.js";
import type { HostAPI } from "../../core/host/host-api.js";
import type { Settings as CoreSettings } from "../../core/settings/shape.js";
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

export interface AuditRecord {
  readonly type: string;
  readonly at: string;
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
}

export interface SessionBootstrap {
  readonly sessionId: string;
  readonly selection: ActiveSelectionHolder;
  readonly projectRoot: string;
  readonly projectTrusted: boolean;
  readonly securityMode: SecurityMode;
  readonly manifest: SessionManifest;
  readonly resumed: boolean;
  readonly yolo: boolean;
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
