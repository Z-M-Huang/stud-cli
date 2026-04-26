/**
 * Lifecycle for the list reference tool.
 *
 * `init`    — derives the workspace root from `host.session.projectRoot`.
 * `dispose` — resets module-level state to defaults; idempotent.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

import { dirname } from "node:path";

import type { ListConfig } from "./config.schema.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_ENTRIES = 1000;

export interface ListState {
  readonly workspaceRoot: string;
  readonly defaultMaxDepth: number;
  readonly maxEntries: number;
}

const DEFAULT_STATE: ListState = {
  workspaceRoot: process.cwd(),
  defaultMaxDepth: DEFAULT_MAX_DEPTH,
  maxEntries: DEFAULT_MAX_ENTRIES,
};

let _state: ListState = DEFAULT_STATE;

export function init(host: HostAPI, cfg: ListConfig): Promise<void> {
  _state = {
    workspaceRoot: dirname(host.session.projectRoot),
    defaultMaxDepth: cfg.defaultMaxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntries: cfg.maxEntries ?? DEFAULT_MAX_ENTRIES,
  };
  return Promise.resolve();
}

export function dispose(_host: HostAPI): Promise<void> {
  _state = DEFAULT_STATE;
  return Promise.resolve();
}

export function getState(): ListState {
  return _state;
}
