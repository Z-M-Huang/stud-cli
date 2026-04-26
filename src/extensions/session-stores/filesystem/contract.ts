import { Session } from "../../../core/errors/index.js";

import { filesystemSessionStoreConfigSchema } from "./config.schema.js";
import {
  FILESYSTEM_STORE_ID,
  activate,
  deactivate,
  dispose,
  init,
  listManifests,
  persistManifest,
  resumeManifest,
} from "./lifecycle.js";

import type { FilesystemSessionStoreConfig } from "./config.schema.js";
import type { DiscoveryRules } from "../../../contracts/meta.js";
import type {
  SessionManifest as ContractSessionManifest,
  SessionStoreContract,
} from "../../../contracts/session-store.js";
import type {
  SessionManifest as CoreSessionManifest,
  SessionMessage,
  SmState,
} from "../../../core/session/manifest/types.js";

function toCoreMessage(message: Readonly<Record<string, unknown>>, index: number): SessionMessage {
  const id =
    typeof message["id"] === "string" && message["id"] !== "" ? message["id"] : `m${index}`;
  const role =
    message["role"] === "user" || message["role"] === "assistant" || message["role"] === "tool"
      ? message["role"]
      : "user";
  const monotonicTs =
    typeof message["monotonicTs"] === "string" && message["monotonicTs"] !== ""
      ? message["monotonicTs"]
      : String(index + 1);
  return { id, role, content: message["content"] ?? message, monotonicTs };
}

function toCoreSmState(smState: ContractSessionManifest["smState"]): SmState | undefined {
  if (smState === undefined) {
    return undefined;
  }
  return {
    smExtId: smState.smExtId,
    slotVersion: "1.0",
    slot: smState.stateSlotRef,
  };
}

function toCoreManifest(manifest: ContractSessionManifest): CoreSessionManifest {
  const base = {
    schemaVersion: "1.0" as const,
    sessionId: manifest.sessionId,
    projectRoot: manifest.projectRoot,
    mode: manifest.mode,
    createdAtMonotonic: String(manifest.createdAt),
    updatedAtMonotonic: String(manifest.updatedAt),
    messages: manifest.messages.map(toCoreMessage),
    writtenByStore: manifest.storeId,
  };
  const smState = toCoreSmState(manifest.smState);
  return smState === undefined ? base : { ...base, smState };
}

function toContractSmState(
  smState: CoreSessionManifest["smState"],
): ContractSessionManifest["smState"] {
  if (smState === undefined) {
    return undefined;
  }
  return {
    smExtId: smState.smExtId,
    stateSlotRef: typeof smState.slot === "string" ? smState.slot : JSON.stringify(smState.slot),
  };
}

function toContractManifest(manifest: CoreSessionManifest): ContractSessionManifest {
  const createdAt = Number(manifest.createdAtMonotonic);
  const updatedAt = Number(manifest.updatedAtMonotonic);
  const createdTimestamp = Number.isFinite(createdAt) ? createdAt : Date.now();
  const updatedTimestamp = Number.isFinite(updatedAt) ? updatedAt : createdTimestamp;
  const base = {
    sessionId: manifest.sessionId,
    projectRoot: manifest.projectRoot,
    mode: manifest.mode,
    messages: manifest.messages.map(
      (message) => ({ ...message }) as Readonly<Record<string, unknown>>,
    ),
    storeId: manifest.writtenByStore,
    createdAt: createdTimestamp,
    updatedAt: updatedTimestamp,
  };
  const smState = toContractSmState(manifest.smState);
  return smState === undefined ? base : { ...base, smState };
}

const discoveryRules: DiscoveryRules = {
  folder: "session-stores",
  manifestKey: "filesystem",
  defaultActivation: true,
};

export const contract: SessionStoreContract<FilesystemSessionStoreConfig> = {
  kind: "SessionStore",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, activate, deactivate, dispose },
  configSchema: filesystemSessionStoreConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "one",
  stateSlot: null,
  discoveryRules,
  reloadBehavior: "never",
  storeId: FILESYSTEM_STORE_ID,
  async read(sessionId, host) {
    try {
      const manifest = await resumeManifest(sessionId, host);
      return { ok: true, manifest: toContractManifest(manifest), slots: [] };
    } catch (err) {
      const error =
        err instanceof Session
          ? err
          : new Session("filesystem resume failed", err, {
              code: "StoreUnavailable",
              sessionId,
            });
      return { ok: false, error };
    }
  },
  async write(manifest, _slots, host) {
    try {
      await persistManifest(toCoreManifest(manifest), host);
      return { ok: true };
    } catch (err) {
      const error =
        err instanceof Session
          ? err
          : new Session("filesystem persist failed", err, {
              code: "StoreUnavailable",
              sessionId: manifest.sessionId,
            });
      return { ok: false, error };
    }
  },
  async list(host) {
    try {
      return { ok: true, sessionIds: await listManifests(host) };
    } catch (err) {
      const error =
        err instanceof Session
          ? err
          : new Session("filesystem list failed", err, {
              code: "StoreUnavailable",
            });
      return { ok: false, error };
    }
  },
};
