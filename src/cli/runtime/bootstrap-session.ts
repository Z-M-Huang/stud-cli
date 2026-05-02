import { join } from "node:path";

import { Session } from "../../core/errors/index.js";
import { openTrustStore } from "../../core/security/trust/store.js";

import { createActiveSelectionHolder } from "./active-selection.js";
import { buildSessionParamsStore } from "./params-runtime.js";
import { validateAndAssertEntryParams } from "./params-validator.js";
import { createSessionManifest } from "./session-store.js";
import { isDirectory, loadSettingsFile } from "./storage.js";

import type { SessionManifest } from "../../contracts/session-store.js";
import type { LaunchArgs } from "../launch-args.js";
import type { ProviderSelection, ResolvedShellDeps, SessionBootstrap, Settings } from "./types.js";

export function resumeUnavailable(): never {
  throw new Session("Resume request did not match an available session", undefined, {
    code: "ResumeMismatch",
  });
}

export async function readTrustedProjectSettings(args: {
  readonly projectRoot: string;
  readonly globalRoot: string;
  readonly deps: ResolvedShellDeps;
  readonly canonicalProjectPath: (projectRoot: string) => Promise<string>;
}): Promise<{ readonly projectTrusted: boolean; readonly settings: Settings | undefined }> {
  if (!(await isDirectory(args.projectRoot))) {
    return { projectTrusted: false, settings: undefined };
  }

  const canonicalPath = await args.canonicalProjectPath(args.projectRoot);
  const store = await openTrustStore(join(args.globalRoot, "trust.json"), {
    userHome: args.deps.homedir(),
  });
  if (!store.has(canonicalPath)) {
    return { projectTrusted: false, settings: undefined };
  }

  return {
    projectTrusted: true,
    settings: (await loadSettingsFile(join(args.projectRoot, "settings.json"))) ?? {},
  };
}

export function newSessionBootstrap(args: {
  readonly launchArgs: LaunchArgs;
  readonly provider: ProviderSelection;
  readonly projectTrusted: boolean;
  readonly securityMode: SessionManifest["mode"];
  readonly deps: ResolvedShellDeps;
}): SessionBootstrap {
  const sessionId = args.deps.sessionIdFactory();
  // Build the store first, then validate the merged effective bag against
  // the active provider/model so `--param` overrides go through the same
  // seven-check pipeline as `defaultParams`.
  const paramsStore = buildSessionParamsStore(
    (args.provider.config as { readonly defaultParams?: Readonly<Record<string, unknown>> })
      .defaultParams,
    args.launchArgs.params,
  );
  if (args.launchArgs.params.length > 0) {
    validateAndAssertEntryParams({
      protocol: args.provider.protocolId,
      entryId: args.provider.entryId,
      modelId: args.provider.modelId,
      params: paramsStore.asMergedBag(),
      sourceLayer: "launch",
    });
  }
  return {
    sessionId,
    selection: createActiveSelectionHolder(args.provider),
    projectRoot: args.launchArgs.projectRoot,
    projectTrusted: args.projectTrusted,
    securityMode: args.securityMode,
    manifest: createSessionManifest({
      sessionId,
      projectRoot: args.launchArgs.projectRoot,
      mode: args.securityMode,
      deps: args.deps,
    }),
    resumed: false,
    yolo: args.launchArgs.yolo,
    paramsStore,
  };
}
