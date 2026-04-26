/**
 * Lifecycle for the read reference tool.
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

import type { ReadConfig } from "./config.schema.js";
import type { HostAPI } from "../../../../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface ReadState {
  /**
   * Absolute path to the workspace root — the parent directory of the `.stud`
   * folder. Only files within this tree may be read.
   */
  readonly workspaceRoot: string;
  /** Maximum content size (bytes) returned to the caller. */
  readonly maxBytes: number;
}

// ---------------------------------------------------------------------------
// Module-level state — shared within one loaded instance
// ---------------------------------------------------------------------------

const DEFAULT_STATE: ReadState = {
  workspaceRoot: process.cwd(),
  maxBytes: DEFAULT_MAX_BYTES,
};

let _state: ReadState = DEFAULT_STATE;

// ---------------------------------------------------------------------------
// Lifecycle handlers
// ---------------------------------------------------------------------------

/**
 * Stores per-instance config. Derives the workspace root from the `.stud`
 * path reported by `host.session.projectRoot`.
 *
 * `host.session.projectRoot` is the absolute path to the `.stud` directory
 * (e.g. `/workspace/.stud`). The workspace root used for path-scope checks
 * is therefore `path.dirname(projectRoot)` (e.g. `/workspace`).
 */
export function init(host: HostAPI, cfg: ReadConfig): Promise<void> {
  _state = {
    workspaceRoot: dirname(host.session.projectRoot),
    maxBytes: cfg.maxBytes ?? DEFAULT_MAX_BYTES,
  };
  return Promise.resolve();
}

/**
 * Resets module state to defaults. Safe to call before `init` or multiple
 * times in succession (idempotent per the meta-contract).
 */
export function dispose(_host: HostAPI): Promise<void> {
  _state = DEFAULT_STATE;
  return Promise.resolve();
}

/**
 * Returns the current lifecycle state for use by the executor and the
 * approval-key derivation function.
 *
 * Returns the default state when `init` has not yet been called.
 */
export function getState(): ReadState {
  return _state;
}
