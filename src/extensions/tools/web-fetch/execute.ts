/**
 * Executor for the web-fetch reference tool.
 *
 * Order of operations:
 *   1. Validate URL syntax + scheme. (`InputInvalid`)
 *   2. Consult Network-Policy with the parsed URL. (`NetworkDenied`)
 *      No HTTP call is made if the policy denies.
 *   3. Issue the bounded fetch with a timeout.
 *   4. Wrap the response with `untrusted: true`.
 *
 * Error mapping:
 *   ToolTerminal/InputInvalid       — URL malformed, missing host, or
 *                                     non-http(s) scheme.
 *   ToolTerminal/NetworkDenied      — Network-Policy rejected the host.
 *   ToolTransient/ExecutionTimeout  — fetch aborted because timeout elapsed.
 *   ToolTerminal/OutputMalformed    — fetch threw for any other reason
 *                                     (DNS failure, connect refused, TLS).
 *
 * The `untrusted: true` field on `WebFetchResult` is a pinned literal that
 * downstream consumers are required to honour — see result.ts.
 *
 * Wiki: reference-extensions/tools/Web-Fetch.md
 */

import { ToolTerminal, ToolTransient } from "../../../core/errors/index.js";

import { extractDomain, isHttpScheme } from "./domain.js";
import { boundedFetch } from "./fetch.js";
import { getState } from "./lifecycle.js";

import type { WebFetchArgs } from "./args.js";
import type { WebFetchResult } from "./result.js";
import type { ToolReturn } from "../../../contracts/tools.js";
import type { HostAPI } from "../../../core/host/host-api.js";

function isAbortError(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const name = (cause as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export async function executeWebFetch(
  args: WebFetchArgs,
  _host: HostAPI,
  _signal: AbortSignal,
): Promise<ToolReturn<WebFetchResult>> {
  if (extractDomain(args.url) === null) {
    return {
      ok: false,
      error: new ToolTerminal("URL is malformed or has no host", undefined, {
        code: "InputInvalid",
        url: args.url,
      }),
    };
  }

  if (!isHttpScheme(args.url)) {
    return {
      ok: false,
      error: new ToolTerminal("URL scheme must be http or https", undefined, {
        code: "InputInvalid",
        url: args.url,
      }),
    };
  }

  const state = getState();
  const parsed = new URL(args.url);

  const policyResult = state.policy.check(parsed);
  if (!policyResult.allowed) {
    return {
      ok: false,
      error: new ToolTerminal("network policy denied outbound request", undefined, {
        code: "NetworkDenied",
        host: parsed.hostname,
        url: args.url,
      }),
    };
  }

  const method = args.method ?? "GET";
  const timeoutMs = args.timeoutMs ?? state.defaultTimeoutMs;
  const headers = args.headers ?? {};

  let outcome;
  try {
    outcome = await boundedFetch(args.url, {
      maxBytes: state.maxBytes,
      timeoutMs,
      method,
      headers,
    });
  } catch (cause) {
    if (isAbortError(cause)) {
      return {
        ok: false,
        error: new ToolTransient(`fetch timed out after ${timeoutMs}ms`, cause, {
          code: "ExecutionTimeout",
          url: args.url,
          timeoutMs,
        }),
      };
    }
    return {
      ok: false,
      error: new ToolTerminal("fetch failed", cause, {
        code: "OutputMalformed",
        url: args.url,
      }),
    };
  }

  const result: WebFetchResult = {
    url: args.url,
    status: outcome.status,
    headers: outcome.headers,
    body: outcome.body,
    truncated: outcome.truncated,
    untrusted: true,
  };

  return { ok: true, value: result };
}
