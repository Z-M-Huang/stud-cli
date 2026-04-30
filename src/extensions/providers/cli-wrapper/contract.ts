import { ExtensionHost } from "../../../core/errors/extension-host.js";

import { cliWrapperConfigSchema, type CLIWrapperConfig } from "./config.schema.js";
import { configForHost, activate, deactivate, dispose, init } from "./lifecycle.js";
import { spawnCLI } from "./spawn.js";
import { shapeCLIStream } from "./stream-shape.js";

import type { ProviderContract } from "../../../contracts/providers.js";

export const contract: ProviderContract<CLIWrapperConfig> = {
  kind: "Provider",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, activate, deactivate, dispose },
  configSchema: cliWrapperConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "providers", manifestKey: "cli-wrapper" },
  reloadBehavior: "between-turns",
  protocol: "cli-wrapper",
  capabilities: {
    streaming: "hard",
    toolCalling: "absent",
    structuredOutput: "absent",
    multimodal: "absent",
    reasoning: "absent",
    contextWindow: "probed",
    promptCaching: "absent",
  },
  surface: {
    async *request(args, host, signal) {
      const config = configForHost(host);
      if (config === undefined) {
        throw new ExtensionHost("CLI wrapper provider has not been initialized.", undefined, {
          code: "LifecycleFailure",
        });
      }

      const seededArgs = config.argsTemplate.map((arg) =>
        arg
          .replaceAll("{seed}", config.seed ?? "")
          .replaceAll("{modelId}", args.modelId)
          .replaceAll("{system}", args.system ?? "")
          .replaceAll("{messages}", JSON.stringify(args.messages)),
      );

      const stdout = spawnCLI({
        executablePath: config.cliRef.path,
        args: seededArgs,
        timeoutMs: config.timeoutMs ?? 10_000,
        signal,
      });

      for await (const event of shapeCLIStream(stdout)) {
        yield event;
      }
    },
  },
};
