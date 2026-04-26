import { fileLoggerConfigSchema, type FileLoggerConfig } from "./config.schema.js";
import { activate, deactivate, dispose, init, sink } from "./lifecycle.js";

import type { LoggerContract } from "../../../contracts/loggers.js";

export const contract: LoggerContract<FileLoggerConfig> = {
  kind: "Logger",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, activate, deactivate, dispose },
  configSchema: fileLoggerConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "loggers", manifestKey: "file" },
  reloadBehavior: "in-turn",
  sink,
};
