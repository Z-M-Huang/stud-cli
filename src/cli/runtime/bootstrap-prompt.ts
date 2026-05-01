import { Validation } from "../../core/errors/index.js";

import { storeSecret } from "./storage.js";
import { PROTOCOLS } from "./types.js";

import type {
  AnyProviderConfig,
  AuthPath,
  ProviderEntryId,
  ProviderProtocolId,
  ResolvedShellDeps,
} from "./types.js";
import type { OpenAICompatibleConfig } from "../../extensions/providers/openai-compatible/config.schema.js";
import type { PromptIO, SelectOption } from "../prompt.js";

export function protocolOptions(): readonly SelectOption<ProviderProtocolId>[] {
  return Object.values(PROTOCOLS).map((descriptor) => ({
    value: descriptor.protocolId,
    label: descriptor.label,
  })) satisfies readonly SelectOption<ProviderProtocolId>[];
}

export function authOptions(protocolId: ProviderProtocolId): readonly SelectOption<AuthPath>[] {
  if (protocolId === "cli-wrapper") {
    return [{ value: "none", label: "no auth required" }];
  }

  return [
    { value: "env-api-key", label: "env-backed API key" },
    { value: "literal-api-key", label: "literal API key (stored as a local secret reference)" },
    {
      value: "auth-device-code",
      label: "Auth.DeviceCode (store returned token as a local secret reference)",
    },
    {
      value: "auth-password",
      label: "Auth.Password (store returned secret as a local secret reference)",
    },
  ];
}

function withDefault(
  defaultValue: string | undefined,
): { readonly defaultValue: string } | undefined {
  return defaultValue === undefined ? undefined : { defaultValue };
}

export interface PromptedProvider {
  readonly authPath: AuthPath;
  readonly entryId: ProviderEntryId;
  readonly protocolId: ProviderProtocolId;
  readonly config: AnyProviderConfig;
}

async function promptEntryId(
  prompt: PromptIO,
  protocolId: ProviderProtocolId,
  existingEntryIds: readonly string[],
): Promise<ProviderEntryId> {
  const proposed = await prompt.input("Provider entry id", { defaultValue: protocolId });
  if (proposed.length === 0) {
    throw new Validation("Provider entry id must not be empty", undefined, {
      code: "ArgumentMissing",
    });
  }
  if (existingEntryIds.includes(proposed)) {
    throw new Validation(`A provider entry named '${proposed}' already exists`, undefined, {
      code: "DuplicateConfigKey",
      entryId: proposed,
    });
  }
  return proposed;
}

async function resolveApiKeyRef(
  prompt: PromptIO,
  protocolId: ProviderProtocolId,
  entryId: ProviderEntryId,
  authPath: AuthPath,
  defaultEnvName: string | undefined,
  secretsPath: string,
  deps: ResolvedShellDeps,
): Promise<OpenAICompatibleConfig["apiKeyRef"]> {
  if (authPath === "env-api-key") {
    return {
      kind: "env",
      name: await prompt.input("Environment variable name", withDefault(defaultEnvName)),
    };
  }
  if (authPath === "none") {
    throw new Validation("A credentialed provider requires an auth path", undefined, {
      code: "ArgumentMissing",
      protocolId,
      entryId,
    });
  }

  const label =
    authPath === "literal-api-key"
      ? "API key"
      : authPath === "auth-device-code"
        ? "Device-code token"
        : "Password or token";
  deps.stdout.write(
    "The secret will be stored in ~/.stud/secrets.json while settings.json keeps only a keyring reference.\n",
  );
  return storeSecret(
    secretsPath,
    entryId,
    authPath,
    await prompt.input(label, { secret: true }),
    deps,
  );
}

export async function promptProviderConfig(
  prompt: PromptIO,
  protocolId: ProviderProtocolId,
  existingEntryIds: readonly string[],
  secretsPath: string,
  deps: ResolvedShellDeps,
): Promise<PromptedProvider> {
  const descriptor = PROTOCOLS[protocolId];
  const authPath = await prompt.select("Choose the provider auth path:", authOptions(protocolId));
  const entryId = await promptEntryId(prompt, protocolId, existingEntryIds);

  if (protocolId === "cli-wrapper") {
    const executablePath = await prompt.input("CLI executable path", {
      defaultValue: "/usr/bin/echo",
    });
    return {
      authPath,
      entryId,
      protocolId,
      config: {
        protocol: "cli-wrapper",
        cliRef: { kind: "executable", path: executablePath },
        argsTemplate: ["stud-cli:", "{messages}"],
        models: [...descriptor.defaultModels],
        timeoutMs: 10_000,
      },
    };
  }

  const apiKeyRef = await resolveApiKeyRef(
    prompt,
    protocolId,
    entryId,
    authPath,
    descriptor.defaultEnvName,
    secretsPath,
    deps,
  );

  const model = await prompt.input("Model", { defaultValue: descriptor.defaultModels[0] });
  const baseURL = await prompt.input("Base URL", withDefault(descriptor.defaultBaseURL));

  if (protocolId === "openai-compatible") {
    return {
      authPath,
      entryId,
      protocolId,
      config: {
        protocol: "openai-compatible",
        apiKeyRef,
        baseURL,
        models: [model],
        apiShape: "chat-completions",
      },
    };
  }
  if (protocolId === "gemini") {
    return {
      authPath,
      entryId,
      protocolId,
      config: { protocol: "gemini", apiKeyRef, models: [model], baseURL },
    };
  }
  return {
    authPath,
    entryId,
    protocolId,
    config: { protocol: "anthropic", apiKeyRef, models: [model], baseURL },
  };
}
