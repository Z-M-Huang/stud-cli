/**
 * Contract declaration for the catalog reference tool.
 *
 * Read-only introspection over the loaded extension registry. Returns
 * public meta-contract metadata (IDs, categories, contract versions,
 * cardinalities) without exposing per-extension config, state, or secrets.
 *
 * Approval model (, Q-8 resolution):
 *   `deriveApprovalKey` returns the fixed string "catalog". Approving once
 *   per session approves all future catalog invocations.
 *
 * Wiki: reference-extensions/tools/Catalog.md
 */
import { catalogConfigSchema } from "./config.schema.js";
import { executeCatalog } from "./execute.js";
import { dispose, init } from "./lifecycle.js";

import type { CatalogArgs } from "./args.js";
import type { CatalogConfig } from "./config.schema.js";
import type { CatalogResult } from "./result.js";
import type { ToolContract } from "../../../contracts/tools.js";

export const contract: ToolContract<CatalogConfig, CatalogArgs, CatalogResult> = {
  kind: "Tool",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: catalogConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "tools", manifestKey: "catalog" },
  reloadBehavior: "between-turns",

  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      filterKind: { type: "string" },
      filterExtId: { type: "string" },
    },
  },

  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["entries"],
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "extId",
            "kind",
            "contractVersion",
            "loadedCardinality",
            "activeCardinality",
            "scope",
            "status",
          ],
          properties: {
            extId: { type: "string" },
            kind: { type: "string" },
            contractVersion: { type: "string" },
            loadedCardinality: { type: "string" },
            activeCardinality: { type: "string" },
            scope: { type: "string", enum: ["bundled", "global", "project"] },
            status: { type: "string", enum: ["loaded", "disabled"] },
          },
        },
      },
    },
  },

  /**
   * Fixed approval key — approving once in `ask` mode approves all future
   * catalog invocations for the session.
   * Wiki: reference-extensions/tools/Catalog.md (, Q-8 resolution)
   */
  gated: true,
  deriveApprovalKey: (_args: CatalogArgs): string => "catalog",

  execute: executeCatalog,
};
