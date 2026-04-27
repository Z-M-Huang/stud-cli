import { contract as anthropicContract } from "../../extensions/providers/anthropic/index.js";
import { contract as cliWrapperContract } from "../../extensions/providers/cli-wrapper/index.js";
import { contract as geminiContract } from "../../extensions/providers/gemini/index.js";
import { contract as openaiCompatibleContract } from "../../extensions/providers/openai-compatible/index.js";

import type { ProviderContract, ProviderToolDefinition } from "../../contracts/providers.js";
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
export type ProviderId = "anthropic" | "cli-wrapper" | "gemini" | "openai-compatible";
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
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultModel: string;
  readonly defaultEnvName?: string;
  readonly defaultBaseURL?: string;
  readonly contract: ProviderContract<unknown>;
}

export interface ProviderSelection {
  readonly providerId: ProviderId;
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
  readonly provider: ProviderSelection;
  readonly projectRoot: string;
  readonly projectTrusted: boolean;
  readonly securityMode: SecurityMode;
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

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  anthropic: {
    id: "anthropic",
    label: "anthropic",
    defaultModel: "claude-opus-4-7",
    defaultEnvName: "ANTHROPIC_API_KEY",
    defaultBaseURL: "https://api.anthropic.com",
    contract: anthropicContract as unknown as ProviderContract<unknown>,
  },
  "cli-wrapper": {
    id: "cli-wrapper",
    label: "cli-wrapper (local subscription/test double)",
    defaultModel: "reference-model",
    contract: cliWrapperContract as unknown as ProviderContract<unknown>,
  },
  gemini: {
    id: "gemini",
    label: "gemini",
    defaultModel: "gemini-2.0-flash",
    defaultEnvName: "GEMINI_API_KEY",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    contract: geminiContract as unknown as ProviderContract<unknown>,
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "openai-compatible",
    defaultModel: "gpt-4o",
    defaultEnvName: "OPENAI_API_KEY",
    defaultBaseURL: "https://api.openai.com/v1",
    contract: openaiCompatibleContract as unknown as ProviderContract<unknown>,
  },
};

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_WEB_CONTENT_BYTES = 5 * 1024 * 1024;
export const TOOL_CALL_CONTINUATION_LIMIT = 12;
