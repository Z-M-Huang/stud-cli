import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import Ajv from "ajv";

import { Session, Validation } from "../../core/errors/index.js";
import { evaluateProjectTrust } from "../../core/project/trust-gate.js";
import { openTrustStore } from "../../core/security/trust/store.js";
import { mergeSettings } from "../../core/settings/validator.js";

import {
  appendAudit,
  atomicWriteJson,
  isDirectory,
  loadSettingsFile,
  nowIso,
  storeSecret,
  studHome,
} from "./storage.js";
import { PROVIDERS } from "./types.js";

import type { TrustStore } from "../../core/security/trust/model.js";
import type { OpenAICompatibleConfig } from "../../extensions/providers/openai-compatible/config.schema.js";
import type { LaunchArgs } from "../launch-args.js";
import type { PromptIO, SelectOption } from "../prompt.js";
import type {
  AnyProviderConfig,
  AuthPath,
  ProjectTrustOutcome,
  ProviderId,
  ProviderSelection,
  ResolvedShellDeps,
  SessionBootstrap,
  Settings,
} from "./types.js";

export function providerLabel(providerId: ProviderId): string {
  return PROVIDERS[providerId].label;
}

function validateProviderConfig(
  providerId: ProviderId,
  config: unknown,
): asserts config is AnyProviderConfig {
  const descriptor = PROVIDERS[providerId];
  const { $schema: _ignored, ...schema } = descriptor.contract.configSchema as Record<
    string,
    unknown
  >;
  const validate = new Ajv({ allErrors: true }).compile(schema);
  if (!validate(config)) {
    throw new Validation(`provider '${providerId}' settings failed schema validation`, undefined, {
      code: "ConfigSchemaViolation",
      providerId,
      errors: validate.errors ?? [],
    });
  }
}

function resolveActiveProviderId(settings: Settings): ProviderId | null {
  const active = settings.active?.provider;
  if (active !== undefined) {
    if (active in PROVIDERS) {
      return active as ProviderId;
    }
    throw new Validation(`Unknown provider '${active}'`, undefined, {
      code: "UnknownConfigKey",
      providerId: active,
    });
  }

  const providerKeys = Object.keys(settings.providers ?? {}).filter(
    (key): key is ProviderId => key in PROVIDERS,
  );
  return providerKeys[0] ?? null;
}

function resolveSecurityMode(args: LaunchArgs, settings: Settings) {
  return args.mode ?? settings.securityMode?.mode ?? "ask";
}

function modelIdFor(providerId: ProviderId, config: AnyProviderConfig): string {
  return providerId === "cli-wrapper"
    ? PROVIDERS[providerId].defaultModel
    : (config as { model: string }).model;
}

function configuredProvider(settings: Settings): ProviderSelection | null {
  const providerId = resolveActiveProviderId(settings);
  if (providerId === null) {
    return null;
  }

  const raw = settings.providers?.[providerId];
  if (raw === undefined) {
    return null;
  }

  validateProviderConfig(providerId, raw);
  return { providerId, config: raw, modelId: modelIdFor(providerId, raw) };
}

function providerOptions(): readonly SelectOption<ProviderId>[] {
  return Object.values(PROVIDERS).map((provider) => ({
    value: provider.id,
    label: provider.label,
  })) satisfies readonly SelectOption<ProviderId>[];
}

function authOptions(providerId: ProviderId): readonly SelectOption<AuthPath>[] {
  if (providerId === "cli-wrapper") {
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

async function promptProviderConfig(
  prompt: PromptIO,
  providerId: ProviderId,
  secretsPath: string,
  deps: ResolvedShellDeps,
): Promise<{ readonly authPath: AuthPath; readonly config: AnyProviderConfig }> {
  const descriptor = PROVIDERS[providerId];
  const authPath = await prompt.select("Choose the provider auth path:", authOptions(providerId));

  if (providerId === "cli-wrapper") {
    const executablePath = await prompt.input("CLI executable path", {
      defaultValue: "/usr/bin/echo",
    });
    return {
      authPath,
      config: {
        cliRef: { kind: "executable", path: executablePath },
        argsTemplate: ["stud-cli:", "{messages}"],
        timeoutMs: 10_000,
      },
    };
  }

  let apiKeyRef: OpenAICompatibleConfig["apiKeyRef"];
  if (authPath === "env-api-key") {
    apiKeyRef = {
      kind: "env",
      name: await prompt.input("Environment variable name", withDefault(descriptor.defaultEnvName)),
    };
  } else {
    if (authPath === "none") {
      throw new Validation("A credentialed provider requires an auth path", undefined, {
        code: "ArgumentMissing",
        providerId,
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
    apiKeyRef = await storeSecret(
      secretsPath,
      providerId,
      authPath,
      await prompt.input(label, { secret: true }),
      deps,
    );
  }

  if (providerId === "openai-compatible") {
    return {
      authPath,
      config: {
        apiKeyRef,
        baseURL: await prompt.input("Base URL", withDefault(descriptor.defaultBaseURL)),
        model: await prompt.input("Model", { defaultValue: descriptor.defaultModel }),
        apiShape: "chat-completions",
      },
    };
  }

  const model = await prompt.input("Model", { defaultValue: descriptor.defaultModel });
  const baseURL = await prompt.input("Base URL", withDefault(descriptor.defaultBaseURL));
  return {
    authPath,
    config: providerId === "gemini" ? { apiKeyRef, model, baseURL } : { apiKeyRef, model, baseURL },
  };
}

async function ensureProviderSettings(
  args: LaunchArgs,
  prompt: PromptIO | undefined,
  globalSettingsPath: string,
  secretsPath: string,
  globalSettings: Settings,
  deps: ResolvedShellDeps,
): Promise<Settings> {
  if (configuredProvider(globalSettings) !== null) {
    return globalSettings;
  }

  if (args.headless) {
    throw new Validation(
      "Headless launch requires a configured default provider and model",
      undefined,
      {
        code: "MissingHeadlessDefaults",
      },
    );
  }
  if (prompt === undefined) {
    throw new Validation("Provider bootstrap requires an interactive prompt", undefined, {
      code: "MissingHeadlessDefaults",
    });
  }

  const providerId = await prompt.select(
    "No provider is configured. Choose one:",
    providerOptions(),
  );
  const configured = await promptProviderConfig(prompt, providerId, secretsPath, deps);
  validateProviderConfig(providerId, configured.config);

  const nextSettings: Settings = {
    ...globalSettings,
    providers: {
      ...(globalSettings.providers ?? {}),
      [providerId]: configured.config as unknown as Readonly<Record<string, unknown>>,
    },
    active: { ...(globalSettings.active ?? {}), provider: providerId },
  };
  await atomicWriteJson(globalSettingsPath, nextSettings);

  const at = nowIso(deps);
  await appendAudit(studHome(deps.homedir()), {
    type: "ProviderRegistered",
    at,
    providerId,
    protocol: PROVIDERS[providerId].contract.protocol,
    authPath: configured.authPath,
  });
  await appendAudit(studHome(deps.homedir()), {
    type: "ExtensionSetRevised",
    at,
    path: globalSettingsPath,
    scope: "global",
  });
  return nextSettings;
}

async function canonicalProjectPath(projectRoot: string): Promise<string> {
  try {
    return await realpath(projectRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return resolve(projectRoot);
    }
    throw error;
  }
}

function adaptTrustStore(store: TrustStore, deps: ResolvedShellDeps) {
  return {
    isGranted(canonicalPath: string): boolean {
      return store.has(canonicalPath);
    },
    async addEntry(canonicalPath: string): Promise<void> {
      await store.grant({ canonicalPath, grantedAt: nowIso(deps), kind: "project" });
    },
    listEntries(): readonly string[] {
      return store.list().map((entry) => entry.canonicalPath);
    },
  };
}

async function resolveProjectTrust(
  args: LaunchArgs,
  prompt: PromptIO | undefined,
  projectExists: boolean,
  globalRoot: string,
  deps: ResolvedShellDeps,
): Promise<ProjectTrustOutcome> {
  if (!projectExists) {
    return "not-applicable";
  }

  const canonicalPath = await canonicalProjectPath(args.projectRoot);
  const store = await openTrustStore(join(globalRoot, "trust.json"), { userHome: deps.homedir() });
  if (store.has(canonicalPath)) {
    return "trusted";
  }
  if (args.headless && args.yolo) {
    await appendAudit(globalRoot, {
      type: "ProjectTrustOnce",
      at: nowIso(deps),
      path: canonicalPath,
      reason: "headless-yolo",
    });
    return "trusted";
  }
  if (args.headless) {
    throw new Validation("Headless launch cannot answer the project trust prompt", undefined, {
      code: "HeadlessTrustRequired",
      projectRoot: canonicalPath,
    });
  }
  if (prompt === undefined) {
    throw new Validation("Project trust requires an interactive prompt", undefined, {
      code: "HeadlessTrustRequired",
      projectRoot: canonicalPath,
    });
  }

  const decision = await prompt.select("Project trust required. Choose how to proceed:", [
    { value: "trust", label: "trust this project" },
    { value: "once", label: "trust once" },
    { value: "decline", label: "decline and continue without project scope" },
    { value: "abort", label: "abort startup" },
  ] as const);

  if (decision === "abort") {
    return "aborted";
  }
  if (decision === "once") {
    await appendAudit(globalRoot, {
      type: "ProjectTrustOnce",
      at: nowIso(deps),
      path: canonicalPath,
    });
    return "trusted";
  }

  const outcome = await evaluateProjectTrust({
    projectRoot: canonicalPath,
    interactor: {
      confirm(): Promise<boolean> {
        return Promise.resolve(decision === "trust");
      },
    },
    trustStore: adaptTrustStore(store, deps),
    audit: {
      write(record): Promise<void> {
        return appendAudit(globalRoot, {
          type: record.decision === "granted" ? "ProjectTrusted" : "ProjectDeclined",
          at: record.at,
          path: record.canonicalPath,
        });
      },
    },
  });

  if (outcome.kind === "refused") {
    await store.recordDecline(canonicalPath, nowIso(deps));
    return "declined";
  }
  return "trusted";
}

export async function bootstrapSession(
  args: LaunchArgs,
  prompt: PromptIO | undefined,
  deps: ResolvedShellDeps,
): Promise<SessionBootstrap | null> {
  if (args.continue) {
    throw new Session("Resume request did not match an available session", undefined, {
      code: "ResumeMismatch",
    });
  }

  const globalRoot = studHome(deps.homedir());
  const globalSettingsPath = join(globalRoot, "settings.json");
  const secretsPath = join(globalRoot, "secrets.json");
  const projectSettingsPath = join(args.projectRoot, "settings.json");
  const globalSettings = await ensureProviderSettings(
    args,
    prompt,
    globalSettingsPath,
    secretsPath,
    (await loadSettingsFile(globalSettingsPath)) ?? {},
    deps,
  );

  const projectExists = await isDirectory(args.projectRoot);
  const trustOutcome = await resolveProjectTrust(args, prompt, projectExists, globalRoot, deps);
  if (trustOutcome === "aborted") {
    return null;
  }

  const projectSettings =
    trustOutcome === "trusted" && projectExists
      ? ((await loadSettingsFile(projectSettingsPath)) ?? {})
      : undefined;
  const mergedSettings = mergeSettings(undefined, globalSettings, projectSettings) as Settings;
  const provider = configuredProvider(mergedSettings);
  if (provider === null) {
    throw new Validation("No usable provider is configured after bootstrap", undefined, {
      code: "MissingHeadlessDefaults",
    });
  }

  return {
    sessionId: deps.sessionIdFactory(),
    provider,
    projectRoot: args.projectRoot,
    projectTrusted: trustOutcome === "trusted",
    securityMode: resolveSecurityMode(args, mergedSettings),
  };
}
