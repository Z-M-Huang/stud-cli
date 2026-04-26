import { Session, Validation } from "../errors/index.js";

import type { AuditAPI } from "../host/api/audit.js";
import type { SessionAPI } from "../host/api/session.js";

export interface StateSlot<T> {
  readonly slotVersion: string;
  readonly data: T;
}

export type DriftDecision = "migrate" | "warn" | "reject";

export interface StateSlotPolicy<T> {
  readonly currentVersion: string;
  decideDrift(stored: StateSlot<unknown>): DriftDecision;
  migrate?(stored: StateSlot<unknown>): StateSlot<T> | Promise<StateSlot<T>>;
}

interface StateSlotRuntime {
  readonly session: SessionAPI;
  readonly audit?: AuditAPI;
}

export function readSlot<T>(
  extId: string,
  policy: StateSlotPolicy<T>,
): Promise<StateSlot<T> | null>;
export function readSlot<T>(
  extId: string,
  policy: StateSlotPolicy<T>,
  runtime: StateSlotRuntime,
): Promise<StateSlot<T> | null>;
export async function readSlot<T>(
  extId: string,
  policy: StateSlotPolicy<T>,
  runtime?: StateSlotRuntime,
): Promise<StateSlot<T> | null> {
  const resolved = requireRuntime(runtime);
  const stored = await resolved.session.stateSlot(extId).read();
  if (stored === null) {
    return null;
  }

  const slot = decodeStoredSlot(extId, stored);
  if (slot.slotVersion === policy.currentVersion) {
    return { slotVersion: slot.slotVersion, data: slot.data as T };
  }

  const decision = policy.decideDrift(slot);
  await recordDrift(resolved.audit, extId, slot.slotVersion, policy.currentVersion, decision);

  switch (decision) {
    case "warn":
      return { slotVersion: slot.slotVersion, data: slot.data as T };
    case "reject":
      throw new Session(
        `State slot for extension '${extId}' has version ${slot.slotVersion}; expected ${policy.currentVersion}`,
        undefined,
        {
          code: "SlotDriftRejected",
          extId,
          storedVersion: slot.slotVersion,
          expectedVersion: policy.currentVersion,
        },
      );
    case "migrate":
      return migrateSlot(extId, policy, slot);
  }
}

export function writeSlot<T>(extId: string, slot: StateSlot<T>): Promise<void>;
export function writeSlot<T>(
  extId: string,
  slot: StateSlot<T>,
  runtime: StateSlotRuntime,
): Promise<void>;
export async function writeSlot<T>(
  extId: string,
  slot: StateSlot<T>,
  runtime?: StateSlotRuntime,
): Promise<void> {
  const resolved = requireRuntime(runtime);
  await resolved.session.stateSlot(extId).write({
    slotVersion: slot.slotVersion,
    data: slot.data,
  });
}

function requireRuntime(runtime?: StateSlotRuntime): StateSlotRuntime {
  if (runtime !== undefined) {
    return runtime;
  }

  throw new Session("state slot runtime is unavailable", undefined, {
    code: "StoreUnavailable",
  });
}

function decodeStoredSlot(
  extId: string,
  stored: Readonly<Record<string, unknown>>,
): StateSlot<unknown> {
  const { slotVersion, data } = stored as {
    readonly slotVersion?: unknown;
    readonly data?: unknown;
  };

  if (typeof slotVersion !== "string") {
    throw new Validation(`State slot for extension '${extId}' has no slotVersion`, undefined, {
      code: "SlotVersionMissing",
      extId,
    });
  }

  return { slotVersion, data };
}

async function migrateSlot<T>(
  extId: string,
  policy: StateSlotPolicy<T>,
  slot: StateSlot<unknown>,
): Promise<StateSlot<T>> {
  if (policy.migrate === undefined) {
    throw new Session(
      `Migration failed for state slot of extension '${extId}' from version ${slot.slotVersion} to ${policy.currentVersion}`,
      undefined,
      {
        code: "SlotMigrationFailed",
        extId,
        storedVersion: slot.slotVersion,
        targetVersion: policy.currentVersion,
      },
    );
  }

  try {
    const migrated = await policy.migrate(slot);
    if (migrated.slotVersion !== policy.currentVersion) {
      throw new Session(
        `Migration failed for state slot of extension '${extId}' from version ${slot.slotVersion} to ${policy.currentVersion}`,
        undefined,
        {
          code: "SlotMigrationFailed",
          extId,
          storedVersion: slot.slotVersion,
          targetVersion: policy.currentVersion,
        },
      );
    }
    return migrated;
  } catch (error) {
    if (error instanceof Session) {
      throw error;
    }

    throw new Session(
      `Migration failed for state slot of extension '${extId}' from version ${slot.slotVersion} to ${policy.currentVersion}`,
      error,
      {
        code: "SlotMigrationFailed",
        extId,
        storedVersion: slot.slotVersion,
        targetVersion: policy.currentVersion,
      },
    );
  }
}

async function recordDrift(
  audit: AuditAPI | undefined,
  extId: string,
  storedVersion: string,
  currentVersion: string,
  decision: DriftDecision,
): Promise<void> {
  await audit?.write({
    severity: "warn",
    code: "StateSlotDrift",
    message: `State slot drift detected for '${extId}'`,
    context: {
      extId,
      storedVersion,
      currentVersion,
      decision,
    },
  });
}
