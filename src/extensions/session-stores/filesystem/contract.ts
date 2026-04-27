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
import type { SessionStoreContract } from "../../../contracts/session-store.js";

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
      return { ok: true, manifest, slots: [] };
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
      await persistManifest(manifest, host);
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
