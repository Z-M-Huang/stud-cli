/**
 * Lifecycle for the web-fetch reference tool.
 *
 * `init`    — stores per-instance config; defaults to a deny-all
 *             NetworkPolicy when none has been injected.
 * `dispose` — resets module-level state to defaults; idempotent.
 *
 * The Network-Policy is injected via `injectNetworkPolicy(host, policy)` —
 * mirroring the trust command's `injectTrustContext` pattern. The default
 * policy denies everything (secure-by-default).
 *
 * Wiki: reference-extensions/tools/Web-Fetch.md + runtime/Network-Policy.md
 */

import { ToolTerminal } from "../../../core/errors/index.js";

import type { WebFetchConfig } from "./config.schema.js";
import type { HostAPI } from "../../../core/host/host-api.js";
import type { NetworkPolicy } from "../../../core/network/policy.js";

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB
const DEFAULT_TIMEOUT_MS = 30_000;

const denyAll: NetworkPolicy = {
  entries: [],
  check: () => ({ allowed: false }),
  assertAllowed: (url: URL): void => {
    throw new ToolTerminal("network policy denied outbound request", undefined, {
      code: "NetworkDenied",
      host: url.hostname,
      url: url.toString(),
    });
  },
  describe: () => [],
};

export interface WebFetchState {
  readonly maxBytes: number;
  readonly defaultTimeoutMs: number;
  readonly policy: NetworkPolicy;
}

const DEFAULT_STATE: WebFetchState = {
  maxBytes: DEFAULT_MAX_BYTES,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  policy: denyAll,
};

let _state: WebFetchState = DEFAULT_STATE;

export function init(_host: HostAPI, cfg: WebFetchConfig): Promise<void> {
  _state = {
    maxBytes: cfg.maxBytes ?? DEFAULT_MAX_BYTES,
    defaultTimeoutMs: cfg.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    policy: _state.policy,
  };
  return Promise.resolve();
}

export function dispose(_host: HostAPI): Promise<void> {
  _state = DEFAULT_STATE;
  return Promise.resolve();
}

export function getState(): WebFetchState {
  return _state;
}

/**
 * Inject a NetworkPolicy. Call after `init` (or before — the policy is
 * preserved across `init`). Tests use this to install allow/deny rules.
 */
export function injectNetworkPolicy(_host: HostAPI, policy: NetworkPolicy): void {
  _state = { ..._state, policy };
}
