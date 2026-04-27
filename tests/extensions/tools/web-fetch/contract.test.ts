/**
 * Contract conformance tests for the web-fetch reference tool.
 *
 * Covers: shape, deriveApprovalKey domain semantics (Q-8), allowed-host
 * happy path with `untrusted: true`, denied-host NetworkDenied (no HTTP
 * call made), non-http(s) InputInvalid, byte-cap truncation, timeout
 * mapping to ToolTransient/ExecutionTimeout, and idempotent dispose.
 *
 * Uses node:test + node:assert/strict; HTTP is mocked via globalThis.fetch
 * stub so no real network egress occurs.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadNetworkPolicy } from "../../../../src/core/network/policy.js";
import {
  contract,
  extractDomain,
  injectNetworkPolicy,
  isHttpScheme,
} from "../../../../src/extensions/tools/web-fetch/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { NetworkAllowlistEntry } from "../../../../src/core/network/policy.js";

interface FetchCall {
  readonly url: string;
  readonly method: string;
}

let originalFetch: typeof globalThis.fetch;
let fetchCalls: FetchCall[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetchMock(
  bodyText: string,
  status = 200,
  headers: Record<string, string> = {},
): void {
  globalThis.fetch = ((input: string | URL | Request) => {
    fetchCalls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: "GET",
    });
    return Promise.resolve(
      new Response(bodyText, {
        status,
        headers: { "content-type": "text/plain", ...headers },
      }),
    );
  }) as typeof fetch;
}

function installStallingFetchMock(): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: "GET",
    });
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        (err as { name: string }).name = "AbortError";
        reject(err);
      });
    });
  }) as typeof fetch;
}

function makePolicy(allow: readonly string[]) {
  const entries: NetworkAllowlistEntry[] = allow.map((host) => ({ host, scope: "project" }));
  return loadNetworkPolicy(entries, [], []);
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("web-fetch tool — shape", () => {
  it("declares Tool category", () => {
    assert.equal(contract.kind, "Tool");
  });

  it("registers under manifestKey 'web-fetch'", () => {
    assert.equal(contract.discoveryRules.manifestKey, "web-fetch");
  });

  it("is gated by the approval stack", () => {
    assert.equal(contract.gated, true);
  });

  it("has no state slot", () => {
    assert.equal(contract.stateSlot, null);
  });

  it("declares semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("exposes inputSchema and outputSchema", () => {
    assert.equal(typeof contract.inputSchema, "object");
    assert.equal(typeof contract.outputSchema, "object");
  });
});

// ---------------------------------------------------------------------------
// domain helpers
// ---------------------------------------------------------------------------

describe("web-fetch tool — domain helpers", () => {
  it("extractDomain returns the URL hostname", () => {
    assert.equal(extractDomain("https://api.github.com/foo/bar"), "api.github.com");
    assert.equal(extractDomain("https://www.example.com/x"), "www.example.com");
    assert.equal(extractDomain("http://localhost:8080/"), "localhost");
  });

  it("extractDomain returns null for malformed URLs", () => {
    assert.equal(extractDomain("not-a-url"), null);
    assert.equal(extractDomain(""), null);
  });

  it("isHttpScheme accepts http and https only", () => {
    assert.equal(isHttpScheme("https://x.com"), true);
    assert.equal(isHttpScheme("http://x.com"), true);
    assert.equal(isHttpScheme("file:///etc/passwd"), false);
    assert.equal(isHttpScheme("ftp://x.com"), false);
    assert.equal(isHttpScheme("not-a-url"), false);
  });
});

// ---------------------------------------------------------------------------
// deriveApprovalKey — domain scope (Q-8)
// ---------------------------------------------------------------------------

describe("web-fetch tool — deriveApprovalKey (domain scope)", () => {
  it("returns the URL hostname for valid URLs", () => {
    assert.equal(
      contract.deriveApprovalKey({ url: "https://api.github.com/foo/bar" }),
      "api.github.com",
    );
    assert.equal(
      contract.deriveApprovalKey({ url: "https://www.example.com/x" }),
      "www.example.com",
    );
  });

  it("subdomains and registrable hosts get distinct keys", () => {
    const apiKey = contract.deriveApprovalKey({ url: "https://api.github.com/x" });
    const wwwKey = contract.deriveApprovalKey({ url: "https://www.github.com/x" });
    assert.notEqual(apiKey, wwwKey);
  });

  it("returns the raw URL when parse fails (executor will reject)", () => {
    const bad = "not-a-url";
    assert.equal(contract.deriveApprovalKey({ url: bad }), bad);
  });
});

// ---------------------------------------------------------------------------
// Execute — success
// ---------------------------------------------------------------------------

describe("web-fetch tool — execute success", () => {
  it("allowed host returns body with untrusted=true", async () => {
    installFetchMock("payload");
    const { host } = mockHost({ extId: "web-fetch" });
    await contract.lifecycle.init!(host, {});
    injectNetworkPolicy(host, makePolicy(["api.example.com"]));

    const signal = new AbortController().signal;
    const result = await contract.execute({ url: "https://api.example.com/x" }, host, signal);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.status, 200);
      assert.equal(result.value.body, "payload");
      assert.equal(result.value.untrusted, true);
      assert.equal(result.value.truncated, false);
    }
    await contract.lifecycle.dispose!(host);
  });

  it("HEAD returns empty body but reports status", async () => {
    installFetchMock("ignored", 200);
    const { host } = mockHost({ extId: "web-fetch" });
    await contract.lifecycle.init!(host, {});
    injectNetworkPolicy(host, makePolicy(["api.example.com"]));

    const signal = new AbortController().signal;
    const result = await contract.execute(
      { url: "https://api.example.com/x", method: "HEAD" },
      host,
      signal,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.body, "");
      assert.equal(result.value.status, 200);
    }
    await contract.lifecycle.dispose!(host);
  });

  it("response over maxBytes → truncated=true with body capped", async () => {
    installFetchMock("y".repeat(50_000));
    const { host } = mockHost({ extId: "web-fetch" });
    await contract.lifecycle.init!(host, { maxBytes: 1024 });
    injectNetworkPolicy(host, makePolicy(["x.com"]));

    const signal = new AbortController().signal;
    const result = await contract.execute({ url: "https://x.com/big" }, host, signal);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.truncated, true);
      assert.ok(result.value.body.length <= 1024);
    }
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — error paths
// ---------------------------------------------------------------------------

describe("web-fetch tool — execute error paths", () => {
  it("disallowed host → ToolTerminal/NetworkDenied (no HTTP call)", async () => {
    installFetchMock("ignored");
    const { host } = mockHost({ extId: "web-fetch" });
    await contract.lifecycle.init!(host, {});
    injectNetworkPolicy(host, makePolicy(["api.example.com"]));

    const signal = new AbortController().signal;
    const result = await contract.execute({ url: "https://ads.example.com/x" }, host, signal);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "NetworkDenied");
    }
    assert.equal(fetchCalls.length, 0, "no fetch should be issued for denied host");
    await contract.lifecycle.dispose!(host);
  });

  it("non-http(s) scheme → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "web-fetch" });
    await contract.lifecycle.init!(host, {});

    const signal = new AbortController().signal;
    const result = await contract.execute({ url: "file:///etc/passwd" }, host, signal);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "InputInvalid");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("malformed URL → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "web-fetch" });
    await contract.lifecycle.init!(host, {});

    const signal = new AbortController().signal;
    const result = await contract.execute({ url: "not-a-url" }, host, signal);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "InputInvalid");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("timeout → ToolTransient/ExecutionTimeout", async () => {
    installStallingFetchMock();
    const { host } = mockHost({ extId: "web-fetch" });
    await contract.lifecycle.init!(host, { defaultTimeoutMs: 25 });
    injectNetworkPolicy(host, makePolicy(["x.com"]));

    const signal = new AbortController().signal;
    const result = await contract.execute({ url: "https://x.com/slow" }, host, signal);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTransient");
      assert.equal(result.error.context["code"], "ExecutionTimeout");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("default policy (no inject) denies everything", async () => {
    installFetchMock("ignored");
    const { host } = mockHost({ extId: "web-fetch" });
    await contract.lifecycle.init!(host, {});

    const signal = new AbortController().signal;
    const result = await contract.execute({ url: "https://example.com/x" }, host, signal);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.context["code"], "NetworkDenied");
    }
    assert.equal(fetchCalls.length, 0);
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("web-fetch tool — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "web-fetch" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("dispose before init does not throw", async () => {
    const { host } = mockHost({ extId: "web-fetch" });
    await assert.doesNotReject(async () => {
      await contract.lifecycle.dispose!(host);
    });
  });
});
