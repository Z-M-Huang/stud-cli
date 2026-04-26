/**
 * Lifecycle for the write reference tool.
 *
 * `init`    — derives the workspace root from `host.session.projectRoot` (the
 *             parent of the `.stud` directory) and stores per-instance config.
 * `dispose` — resets module-level state to defaults; idempotent.
 *
 * The workspace root is stored in module-level state so that both the executor
 * and `deriveApprovalKey` can access it without receiving a host reference.
 *
 * Wiki: reference-extensions/tools/Simple-Tools.md
 */

import { dirname } from "node:path";

import type { WriteConfig } from "./config.schema.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB

export interface WriteState {
  /**
   * Absolute path to the workspace root — the parent directory of the `.stud`
   * folder. Only files within this tree may be written.
   */
  readonly workspaceRoot: string;
  /** Maximum UTF-8 byte length of `content` accepted by the executor. */
  readonly maxBytes: number;
}

const DEFAULT_STATE: WriteState = {
  workspaceRoot: process.cwd(),
  maxBytes: DEFAULT_MAX_BYTES,
};

let _state: WriteState = DEFAULT_STATE;

/**
 * Stores per-instance config. The workspace root is `dirname(projectRoot)`
 * because `host.session.projectRoot` points at the `.stud` directory.
 */
export function init(host: HostAPI, cfg: WriteConfig): Promise<void> {
  _state = {
    workspaceRoot: dirname(host.session.projectRoot),
    maxBytes: cfg.maxBytes ?? DEFAULT_MAX_BYTES,
  };
  return Promise.resolve();
}

/** Resets module state to defaults. Safe to call before init or repeatedly. */
export function dispose(_host: HostAPI): Promise<void> {
  _state = DEFAULT_STATE;
  return Promise.resolve();
}

/** Returns the current lifecycle state for the executor and approval-key fn. */
export function getState(): WriteState {
  return _state;
}
