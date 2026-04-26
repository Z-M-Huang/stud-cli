import { defaultTUIConfigSchema, type DefaultTUIConfig } from "./config.schema.js";
import { keyboardShortcuts } from "./keyboard.js";
import {
  activate,
  deactivate,
  dispose,
  init,
  onInteraction,
  respondInteraction,
} from "./lifecycle.js";

import type { UIContract } from "../../../contracts/ui.js";

const discoveryRules = {
  folder: "ui",
  manifestKey: "default-tui",
} as const;

type DefaultTUIContract = UIContract<DefaultTUIConfig> & {
  readonly keyboardShortcuts: typeof keyboardShortcuts;
  readonly respondInteraction: typeof respondInteraction;
};

export const contract: DefaultTUIContract = {
  kind: "UI",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, activate, deactivate, dispose },
  configSchema: defaultTUIConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules,
  reloadBehavior: "between-turns",
  roles: ["subscriber", "interactor"],
  onEvent(): Promise<void> {
    return Promise.resolve();
  },
  onInteraction,
  keyboardShortcuts,
  respondInteraction,
};
