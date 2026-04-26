/**
 * HostSessionImpl — per-extension session wrapper.
 *
 * `createHostSession` returns a frozen object exposing session id, security
 * mode, and the `stateSlot` accessor.  The `stateSlot` guard enforces AC-115:
 * an extension may only access its own state slot.  Any attempt to pass a
 * foreign `extId` throws `ExtensionHost/SlotAccessDenied` and emits an audit
 * record.
 *
 * AC-56:  the returned object is `Object.freeze`'d.
 * AC-115: cross-extension stateSlot access is denied at runtime.
 * Invariant #3: mode is session-fixed; the returned value never changes.
 * Invariant #6: session manifest never stores resolved secrets — stateSlot
 *               values must not contain secret material (caller's responsibility).
 *
 * Wiki: core/Host-API.md + contracts/Extension-State.md
 */

import { ExtensionHost } from "../../errors/extension-host.js";

import type { HostAuditImpl } from "./audit.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Handle returned by `HostSessionImpl.stateSlot`. */
export interface StateSlotHandle {
  readonly get: <T>() => T | undefined;
  readonly set: <T>(value: T) => Promise<void>;
}

/**
 * The concrete session wrapper given to one extension.
 *
 * `stateSlot(extId)` may only be called with the own `extId` — any other value
 * throws `ExtensionHost/SlotAccessDenied` (AC-115).
 */
export interface HostSessionImpl {
  readonly stateSlot: (extId: string) => StateSlotHandle;
  readonly sessionId: () => string;
  readonly mode: () => "ask" | "yolo" | "allowlist";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a per-extension session wrapper.
 *
 * @param deps.extId      - The owning extension's canonical ID.
 * @param deps.stateStore - The underlying state store that persists slot values.
 * @param deps.sessionId  - Stable session identifier for this session.
 * @param deps.mode       - Security mode, fixed at session start (invariant #3).
 * @param deps.audit      - Per-extension audit wrapper for recording access violations.
 */
export function createHostSession(deps: {
  extId: string;
  stateStore: {
    get: (extId: string) => unknown;
    set: (extId: string, v: unknown) => Promise<void>;
  };
  sessionId: string;
  mode: "ask" | "yolo" | "allowlist";
  audit: HostAuditImpl;
}): HostSessionImpl {
  const { extId: ownExtId, stateStore, sessionId, mode, audit } = deps;

  function stateSlot(requestedExtId: string): StateSlotHandle {
    if (requestedExtId !== ownExtId) {
      // AC-115: record the violation before throwing.
      audit.record({
        class: "ExtensionHost",
        code: "SlotAccessDenied",
        data: { ownExtId, requestedExtId },
      });
      throw new ExtensionHost(
        `extension '${ownExtId}' attempted to access state slot of '${requestedExtId}'; only own slot is permitted`,
        undefined,
        { code: "SlotAccessDenied", ownExtId, requestedExtId },
      );
    }

    const handle: StateSlotHandle = {
      get<T>(): T | undefined {
        return stateStore.get(ownExtId) as T | undefined;
      },
      set<T>(value: T): Promise<void> {
        return stateStore.set(ownExtId, value);
      },
    };

    return Object.freeze(handle);
  }

  const impl: HostSessionImpl = {
    stateSlot,
    sessionId: () => sessionId,
    mode: () => mode,
  };

  return Object.freeze(impl);
}
