/**
 * Lifecycle for the edit reference tool.
 *
 * `init`    — derives the workspace root from `host.session.projectRoot` (the
 *             parent of the `.stud` directory) and stores per-instance config.
 * `dispose` — resets module-level state to defaults; idempotent.
 *
 * The workspace root is stored in module-level state so that both the executor
 * and `deriveApprovalKey` can access it without receiving a host reference.
 *
 * Wiki: reference-extensions/tools/Edit.md
 */

import { dirname } from "node:path";

import type { EditConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FILE_BYTES = 10_485_760; // 10 MiB

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface EditState {
  /**
   * Absolute path to the workspace root — the parent directory of the `.stud`
   * folder. Only files within this tree may be edited.
   */
  readonly workspaceRoot: string;
  /** Maximum file size (bytes) that may be read and rewritten. */
  readonly maxFileBytes: number;
}

// ---------------------------------------------------------------------------
// Module-level state — shared within one loaded instance
// ---------------------------------------------------------------------------

const DEFAULT_STATE: EditState = {
  workspaceRoot: process.cwd(),
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
};

let _state: EditState = DEFAULT_STATE;

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
export function init(host: HostAPI, cfg: EditConfig): Promise<void> {
  _state = {
    workspaceRoot: dirname(host.session.projectRoot),
    maxFileBytes: cfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
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
export function getState(): EditState {
  return _state;
}
