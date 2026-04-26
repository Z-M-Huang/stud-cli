/**
 * Contract declaration for the web-fetch reference tool.
 *
 * Performs an HTTP(S) request subject to the Network-Policy, caps response
 * size, and returns the body marked as `untrusted: true`. Approval-gated
 * with a per-domain key so repeated fetches to the same host share approval.
 *
 * Wiki: reference-extensions/tools/Web-Fetch.md
 */

import { webFetchConfigSchema } from "./config.schema.js";
import { extractDomain } from "./domain.js";
import { executeWebFetch } from "./execute.js";
import { dispose, init } from "./lifecycle.js";

import type { WebFetchArgs } from "./args.js";
import type { WebFetchConfig } from "./config.schema.js";
import type { WebFetchResult } from "./result.js";
import type { ToolContract } from "../../../contracts/tools.js";

export const contract: ToolContract<WebFetchConfig, WebFetchArgs, WebFetchResult> = {
  kind: "Tool",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, dispose },
  configSchema: webFetchConfigSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "tools", manifestKey: "web-fetch" },
  reloadBehavior: "between-turns",

  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", minLength: 1 },
      method: { type: "string", enum: ["GET", "HEAD"] },
      headers: { type: "object", additionalProperties: { type: "string" } },
      timeoutMs: { type: "integer", minimum: 1 },
    },
  },

  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["url", "status", "headers", "body", "truncated", "untrusted"],
    properties: {
      url: { type: "string" },
      status: { type: "integer", minimum: 100, maximum: 599 },
      headers: { type: "object", additionalProperties: { type: "string" } },
      body: { type: "string" },
      truncated: { type: "boolean" },
      untrusted: { type: "boolean", const: true },
    },
  },

  /** Always gated; key is the URL's hostname (per Q-8). */
  gated: true,

  deriveApprovalKey: (args: WebFetchArgs): string => {
    const host = extractDomain(args.url);
    // Falling back to raw URL when parse fails — executor will reject with
    // InputInvalid; the approval key is moot in that case but must be stable.
    return host ?? args.url;
  },

  execute: executeWebFetch,
};
