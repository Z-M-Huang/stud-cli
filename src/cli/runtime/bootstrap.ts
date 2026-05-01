import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import Ajv from "ajv";

import { Validation } from "../../core/errors/index.js";
import { evaluateProjectTrust } from "../../core/project/trust-gate.js";
import { openTrustStore } from "../../core/security/trust/store.js";
import { mergeSettings } from "../../core/settings/validator.js";

import { createActiveSelectionHolder } from "./active-selection.js";
import { promptProviderConfig, protocolOptions } from "./bootstrap-prompt.js";
import {
  newSessionBootstrap,
  readTrustedProjectSettings,
  resumeUnavailable,
} from "./bootstrap-session.js";
import { readLatestSessionManifest } from "./session-store.js";
import {
  appendAudit,
  atomicWriteJson,
  ensureSystemPromptScaffold,
  isDirectory,
  loadSettingsFile,
  nowIso,
  studHome,
} from "./storage.js";
import { PROTOCOLS } from "./types.js";

import type { TrustStore } from "../../core/security/trust/model.js";
import type { LaunchArgs } from "../launch-args.js";
import type { PromptIO } from "../prompt.js";
import type {
  AnyProviderConfig,
  ProjectTrustOutcome,
  ProviderEntryId,
  ProviderProtocolId,
  ProviderSelection,
  ResolvedShellDeps,
  SessionBootstrap,
  Settings,
} from "./types.js";

export function protocolLabel(protocolId: ProviderProtocolId): string {
  return PROTOCOLS[protocolId].label;
}

function isProtocolId(value: unknown): value is ProviderProtocolId {
  return typeof value === "string" && value in PROTOCOLS;
}

function validateProviderConfig(
  protocolId: ProviderProtocolId,
  entryId: ProviderEntryId,
  config: unknown,
): asserts config is AnyProviderConfig {
  const descriptor = PROTOCOLS[protocolId];
  const { $schema: _ignored, ...schema } = descriptor.contract.configSchema as Record<
    string,
    unknown
  >;
  const validate = new Ajv({ allErrors: true }).compile(schema);
  if (!validate(config)) {
    throw new Validation(
      `provider entry '${entryId}' (protocol '${protocolId}') failed schema validation`,
      undefined,
      {
        code: "ConfigSchemaViolation",
        entryId,
        protocolId,
        errors: validate.errors ?? [],
      },
    );
  }
}

export interface ResolvedActiveEntry {
  readonly entryId: ProviderEntryId;
  readonly protocolId: ProviderProtocolId;
  readonly raw: Readonly<Record<string, unknown>>;
}

export function resolveActiveEntry(settings: Settings): ResolvedActiveEntry | null {
  const providers = (settings.providers ?? {}) as Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  const explicit = settings.active?.provider;
  const entryId = explicit ?? Object.keys(providers)[0];
  if (entryId === undefined) {
    return null;
  }

  const raw = providers[entryId];
  if (raw === undefined) {
    throw new Validation(`provider entry '${entryId}' is not configured`, undefined, {
      code: "UnknownConfigKey",
      entryId,
    });
  }

  // Detect legacy single-model entries (pre-1.0.1) so the user gets an
  // actionable hint rather than an opaque AJV error. No migration is performed.
  if (raw["models"] === undefined && typeof (raw as { model?: unknown }).model === "string") {
    throw new Validation(
      `provider entry '${entryId}' uses the legacy single-model shape; rename 'model' to 'models: [...]' and add 'protocol'`,
      undefined,
      {
        code: "SettingsLegacyShape",
        entryId,
        hint: 'rename "model": "x" to "models": ["x"] and add "protocol": "openai-compatible" (or matching adapter id) at the entry root',
      },
    );
  }

  const protocol = (raw as { protocol?: unknown }).protocol;
  if (!isProtocolId(protocol)) {
    throw new Validation(
      `provider entry '${entryId}' has unknown or missing 'protocol' field`,
      undefined,
      {
        code: "UnknownProtocol",
        entryId,
        protocol,
      },
    );
  }

  return { entryId, protocolId: protocol, raw };
}

function resolveSecurityMode(args: LaunchArgs, settings: Settings) {
  return args.mode ?? settings.securityMode?.mode ?? "ask";
}

export function resolveActiveModelId(
  settings: Settings,
  entryId: ProviderEntryId,
  config: AnyProviderConfig,
): string {
  const requested = settings.active?.model;
  const models = (config as { readonly models: readonly [string, ...string[]] }).models;
  if (requested !== undefined) {
    if (!models.includes(requested)) {
      throw new Validation(
        `active.model '${requested}' is not declared in provider entry '${entryId}'`,
        undefined,
        {
          code: "ActiveModelNotInProvider",
          entryId,
          model: requested,
          models,
        },
      );
    }
    return requested;
  }
  return models[0];
}

export function configuredProvider(settings: Settings): ProviderSelection | null {
  const entry = resolveActiveEntry(settings);
  if (entry === null) {
    return null;
  }

  validateProviderConfig(entry.protocolId, entry.entryId, entry.raw);
  const config = entry.raw as unknown as AnyProviderConfig;
  return {
    entryId: entry.entryId,
    protocolId: entry.protocolId,
    config,
    modelId: resolveActiveModelId(settings, entry.entryId, config),
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

  const protocolId = await prompt.select(
    "No provider is configured. Choose a protocol:",
    protocolOptions(),
  );
  const existingEntryIds = Object.keys(globalSettings.providers ?? {});
  const configured = await promptProviderConfig(
    prompt,
    protocolId,
    existingEntryIds,
    secretsPath,
    deps,
  );
  validateProviderConfig(protocolId, configured.entryId, configured.config);

  const firstModel = (configured.config as { readonly models: readonly [string, ...string[]] })
    .models[0];
  const nextSettings: Settings = {
    ...globalSettings,
    providers: {
      ...(globalSettings.providers ?? {}),
      [configured.entryId]: configured.config as unknown as Readonly<Record<string, unknown>>,
    },
    active: {
      ...(globalSettings.active ?? {}),
      provider: configured.entryId,
      model: firstModel,
    },
  };
  await atomicWriteJson(globalSettingsPath, nextSettings);

  const at = nowIso(deps);
  await appendAudit(studHome(deps.homedir()), {
    type: "ProviderRegistered",
    at,
    entryId: configured.entryId,
    protocolId: configured.protocolId,
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

async function bootstrapResumedSession(args: {
  readonly prompt: PromptIO | undefined;
  readonly launchArgs: LaunchArgs;
  readonly globalRoot: string;
  readonly globalSettingsPath: string;
  readonly secretsPath: string;
  readonly globalSettings: Settings;
  readonly deps: ResolvedShellDeps;
}): Promise<SessionBootstrap> {
  const manifest = await readLatestSessionManifest(args.globalRoot);
  if (manifest === null) {
    resumeUnavailable();
  }

  const globalSettings = await ensureProviderSettings(
    args.launchArgs,
    args.prompt,
    args.globalSettingsPath,
    args.secretsPath,
    args.globalSettings,
    args.deps,
  );
  const project = await readTrustedProjectSettings({
    projectRoot: manifest.projectRoot,
    globalRoot: args.globalRoot,
    deps: args.deps,
    canonicalProjectPath,
  });
  const mergedSettings = mergeSettings(undefined, globalSettings, project.settings) as Settings;
  const provider = configuredProvider(mergedSettings);
  if (provider === null) {
    throw new Validation("No usable provider is configured after resume", undefined, {
      code: "MissingHeadlessDefaults",
    });
  }

  return {
    sessionId: manifest.sessionId,
    selection: createActiveSelectionHolder(provider),
    projectRoot: manifest.projectRoot,
    projectTrusted: project.projectTrusted,
    securityMode: manifest.mode,
    manifest,
    resumed: true,
    yolo: args.launchArgs.yolo,
  };
}

export async function bootstrapSession(
  args: LaunchArgs,
  prompt: PromptIO | undefined,
  deps: ResolvedShellDeps,
): Promise<SessionBootstrap | null> {
  const globalRoot = studHome(deps.homedir());
  const globalSettingsPath = join(globalRoot, "settings.json");
  const secretsPath = join(globalRoot, "secrets.json");
  const loadedGlobalSettings = (await loadSettingsFile(globalSettingsPath)) ?? {};

  if (await ensureSystemPromptScaffold(globalRoot)) {
    await appendAudit(globalRoot, {
      type: "SystemPromptScaffolded",
      at: nowIso(deps),
      path: join(globalRoot, "system.md"),
    });
  }

  if (args.continue) {
    return bootstrapResumedSession({
      prompt,
      launchArgs: args,
      globalRoot,
      globalSettingsPath,
      secretsPath,
      globalSettings: loadedGlobalSettings,
      deps,
    });
  }

  const projectSettingsPath = join(args.projectRoot, "settings.json");
  const globalSettings = await ensureProviderSettings(
    args,
    prompt,
    globalSettingsPath,
    secretsPath,
    loadedGlobalSettings,
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

  return newSessionBootstrap({
    launchArgs: args,
    provider,
    projectTrusted: trustOutcome === "trusted",
    securityMode: resolveSecurityMode(args, mergedSettings),
    deps,
  });
}
