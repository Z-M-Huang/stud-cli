/**
 * Lifecycle function signatures shared by every extension category.
 *
 * All four phases are optional. An extension may implement any subset; core
 * defaults absent phases to no-ops. `dispose` is always idempotent — core may
 * call it more than once (e.g., on error paths) and the implementation must
 * tolerate repeated invocations without error.
 *
 * Phase order enforced by core:
 *   init → activate → deactivate → dispose
 *
 * `init`       — Called once when the extension is loaded. Receives the host
 *   API and the extension's validated config.  Use for subscription setup and
 *   one-time resource acquisition.
 *
 * `activate`   — Called when the extension transitions from loaded to active.
 *   May be called multiple times across a session (e.g., after a hot-reload
 *   that ends with `deactivate` and then `activate` again).
 *
 * `deactivate` — Called when the extension steps back to the loaded state
 *   without being fully disposed. Release active resources; leave subscriptions
 *   intact so a subsequent `activate` can resume cleanly.
 *
 * `dispose`    — Called once, or more than once on error paths. Must be
 *   idempotent. Unsubscribe all event listeners, release all resources, null
 *   out held references.
 *
 * Wiki: contracts/Contract-Pattern.md
 */
import type { HostAPI } from "../core/host/host-api.js";

export interface LifecycleFns<TConfig> {
  readonly init?: (host: HostAPI, cfg: TConfig) => Promise<void>;
  readonly activate?: (host: HostAPI) => Promise<void>;
  readonly deactivate?: (host: HostAPI) => Promise<void>;
  /** Always idempotent — safe to call more than once. */
  readonly dispose?: (host: HostAPI) => Promise<void>;
}
