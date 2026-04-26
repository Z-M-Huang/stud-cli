/**
 * Executor for the catalog reference tool.
 *
 * Reads the loaded extension registry, applies optional filters, and returns
 * redacted public metadata. Never exposes config bodies, stateSlot contents,
 * or credentials.
 *
 * Error protocol:
 *   - Throws Cancellation/TurnCancelled when the abort signal is already set.
 *   - No ToolTransient — registry read is synchronous and in-memory.
 *   - Invalid filter values return an empty list, not an error.
 *
 * Wiki: reference-extensions/tools/Catalog.md
 */
import { Cancellation } from "../../../core/errors/index.js";

import { getIncludeDisabled, getRegistryEntries } from "./lifecycle.js";
import { redactEntry } from "./redact.js";

import type { CatalogArgs } from "./args.js";
import type { CatalogResult } from "./result.js";
import type { ToolReturn } from "../../../contracts/tools.js";
import type { HostAPI } from "../../../core/host/host-api.js";

export function executeCatalog(
  args: CatalogArgs,
  _host: HostAPI,
  signal: AbortSignal,
): Promise<ToolReturn<CatalogResult>> {
  if (signal.aborted) {
    throw new Cancellation("execution aborted before start", undefined, {
      code: "TurnCancelled",
    });
  }

  let entries = getRegistryEntries();

  // Exclude disabled extensions unless the config says otherwise.
  if (!getIncludeDisabled()) {
    entries = entries.filter((e) => e.status !== "disabled");
  }

  // Narrow by kind when requested; invalid values produce an empty list.
  if (args.filterKind !== undefined) {
    entries = entries.filter((e) => e.kind === args.filterKind);
  }

  // Narrow by extId when requested; invalid values produce an empty list.
  if (args.filterExtId !== undefined) {
    entries = entries.filter((e) => e.extId === args.filterExtId);
  }

  return Promise.resolve({
    ok: true,
    value: { entries: Object.freeze(entries.map(redactEntry)) },
  });
}
