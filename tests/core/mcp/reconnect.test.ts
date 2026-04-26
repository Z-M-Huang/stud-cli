import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";

import { ProviderTransient } from "../../../src/core/errors/provider-transient.js";
import { Validation } from "../../../src/core/errors/validation.js";
import { clearRegistry, registerServer } from "../../../src/core/mcp/client.js";
import { clearTrust, checkTrust, grantTrust } from "../../../src/core/mcp/trust.js";

import type { MCPClient } from "../../../src/core/mcp/client.js";

const reconnectModule: {
  readonly defaultReconnectPolicy: {
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
    readonly maxAttempts: number;
    readonly jitter: number;
  };
  readonly reconnect: (
    serverId: string,
    policy?: {
      readonly initialDelayMs: number;
      readonly maxDelayMs: number;
      readonly maxAttempts: number;
      readonly jitter: number;
    },
  ) => Promise<{
    readonly serverId: string;
    readonly attempts: number;
    readonly reconnected: boolean;
    readonly totalDelayMs: number;
  }>;
} = await import(new URL("../../../src/core/mcp/reconnect.ts", import.meta.url).href);
const { defaultReconnectPolicy, reconnect } = reconnectModule;

const originalHome = process.env["HOME"];
const originalRandom = globalThis.Math.random.bind(globalThis.Math);

function registerFixtureServer(
  id: string,
  scope: "bundled" | "global" | "project" = "global",
): void {
  registerServer({
    id,
    transport: "stdio",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    scope,
  });
}

function createReconnectStubClient(
  options: {
    readonly successesAfter?: Readonly<Record<string, number>>;
    readonly alwaysFail?: readonly string[];
    readonly auditLog?: string[];
  } = {},
): MCPClient {
  const attempts = new Map<string, number>();
  const successesAfter = options.successesAfter ?? {};
  const alwaysFail = new Set(options.alwaysFail ?? []);

  return {
    connect: (id: string): Promise<void> => {
      const nextAttempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, nextAttempt);
      options.auditLog?.push(`connect:${id}:${nextAttempt}`);

      if (alwaysFail.has(id)) {
        return Promise.reject(new Error(`connection failed for ${id}`));
      }

      const succeedAt = Object.prototype.hasOwnProperty.call(successesAfter, id)
        ? successesAfter[id]!
        : 1;
      if (nextAttempt < succeedAt) {
        return Promise.reject(new Error(`transient connection failure for ${id}`));
      }

      return Promise.resolve();
    },
    disconnect: (id: string): Promise<void> => {
      options.auditLog?.push(`disconnect:${id}`);
      return Promise.resolve();
    },
    listTools: (): Promise<readonly []> => Promise.resolve([]),
    listPrompts: (): Promise<readonly []> => Promise.resolve([]),
    listResources: (): Promise<readonly []> => Promise.resolve([]),
    callTool: (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true }),
    readResource: (): Promise<{ readonly content: string; readonly mimeType: string }> =>
      Promise.resolve({ content: "", mimeType: "text/plain" }),
    getPrompt: (): Promise<{ readonly messages: unknown[] }> => Promise.resolve({ messages: [] }),
  };
}

async function createTempHome(): Promise<string> {
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "stud-mcp-reconnect-"));
  process.env["HOME"] = dir;
  return dir;
}

afterEach(async () => {
  Math.random = originalRandom;
  process.env["HOME"] = originalHome;
  try {
    registerFixtureServer("srv-trusted-flaky");
    await clearTrust("srv-trusted-flaky");
  } catch {
    // best-effort cleanup for trust state
  }
  clearRegistry();
  delete (
    globalThis as typeof globalThis & {
      __studCliMcpClient__?: MCPClient;
      __studCliMcpClientSingleton__?: MCPClient;
      __studCliMcpAuditHook__?: (payload: unknown) => void;
    }
  ).__studCliMcpClient__;
  delete (
    globalThis as typeof globalThis & {
      __studCliMcpClientSingleton__?: MCPClient;
    }
  ).__studCliMcpClientSingleton__;
  delete (
    globalThis as typeof globalThis & {
      __studCliMcpAuditHook__?: (payload: unknown) => void;
    }
  ).__studCliMcpAuditHook__;
});

function installStubClient(client: MCPClient): void {
  (
    globalThis as typeof globalThis & {
      __studCliMcpClient__?: MCPClient;
    }
  ).__studCliMcpClient__ = client;
}

function installAuditHook(
  hook: (payload: {
    event: string;
    serverId: string;
    attempt?: number;
    delayMs?: number;
    attempts?: number;
    totalDelayMs?: number;
  }) => void,
): void {
  (
    globalThis as typeof globalThis & {
      __studCliMcpAuditHook__?: (payload: {
        event: string;
        serverId: string;
        attempt?: number;
        delayMs?: number;
        attempts?: number;
        totalDelayMs?: number;
      }) => void;
    }
  ).__studCliMcpAuditHook__ = hook;
}

function assertDefaultPolicy(): void {
  assert.deepEqual(defaultReconnectPolicy, {
    initialDelayMs: 250,
    maxDelayMs: 4_000,
    maxAttempts: 5,
    jitter: 0.2,
  });
}

async function assertReconnectsFirstAttempt(): Promise<void> {
  registerFixtureServer("srv-ok");
  installStubClient(createReconnectStubClient());

  const outcome = await reconnect("srv-ok");

  assert.equal(outcome.reconnected, true);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.totalDelayMs, 0);
}

async function assertExponentialBackoff(): Promise<void> {
  registerFixtureServer("srv-flaky");
  Math.random = () => 0.5;
  installStubClient(
    createReconnectStubClient({
      successesAfter: { "srv-flaky": 4 },
    }),
  );

  const outcome = await reconnect("srv-flaky", {
    initialDelayMs: 10,
    maxDelayMs: 200,
    maxAttempts: 4,
    jitter: 0,
  });

  assert.equal(outcome.reconnected, true);
  assert.equal(outcome.attempts, 4);
  assert.equal(outcome.totalDelayMs >= 10 + 20 + 40, true);
}

async function assertExhaustionError(): Promise<void> {
  registerFixtureServer("srv-dead");
  Math.random = () => 0.5;
  installStubClient(
    createReconnectStubClient({
      alwaysFail: ["srv-dead"],
    }),
  );

  await assert.rejects(
    () =>
      reconnect("srv-dead", {
        initialDelayMs: 1,
        maxDelayMs: 4,
        maxAttempts: 3,
        jitter: 0,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderTransient);
      assert.equal(error.class, "ProviderTransient");
      assert.equal(error.context["code"], "MCPConnectionLost");
      return true;
    },
  );
}

async function assertTrustPreserved(): Promise<void> {
  await createTempHome();
  registerFixtureServer("srv-trusted-flaky");
  await grantTrust("srv-trusted-flaky", "global");
  installStubClient(
    createReconnectStubClient({
      successesAfter: { "srv-trusted-flaky": 2 },
    }),
  );

  await reconnect("srv-trusted-flaky", {
    initialDelayMs: 1,
    maxDelayMs: 2,
    maxAttempts: 2,
    jitter: 0,
  });

  assert.equal(await checkTrust("srv-trusted-flaky"), "trusted");
}

async function assertUnknownServerError(): Promise<void> {
  await assert.rejects(
    () => reconnect("ghost"),
    (error: unknown) => {
      assert.equal((error as { class?: string }).class, "Validation");
      assert.equal(
        (error as { context?: { code?: string } }).context?.code,
        "MCPServerNotRegistered",
      );
      return true;
    },
  );
}

async function assertReconnectAttemptEvents(): Promise<void> {
  registerFixtureServer("srv-ok");
  const events: {
    event: string;
    serverId: string;
    attempt?: number;
    delayMs?: number;
    attempts?: number;
    totalDelayMs?: number;
  }[] = [];
  installAuditHook((payload) => {
    events.push(payload);
  });
  installStubClient(createReconnectStubClient());

  await reconnect("srv-ok");

  assert.equal(events.filter((event) => event.event === "MCPReconnectAttempt").length, 1);
  assert.deepEqual(events[0], { event: "MCPServerDisconnected", serverId: "srv-ok" });
  assert.deepEqual(events[1], {
    event: "MCPReconnectAttempt",
    serverId: "srv-ok",
    attempt: 1,
    delayMs: 0,
  });
  assert.deepEqual(events[2], {
    event: "MCPServerReconnected",
    serverId: "srv-ok",
    attempts: 1,
    totalDelayMs: 0,
  });
}

async function assertReusesSingletonClient(): Promise<void> {
  registerFixtureServer("srv-singleton");
  const auditLog: string[] = [];
  (
    globalThis as typeof globalThis & {
      __studCliMcpClientSingleton__?: MCPClient;
    }
  ).__studCliMcpClientSingleton__ = createReconnectStubClient({ auditLog });

  const outcome = await reconnect("srv-singleton");

  assert.equal(outcome.reconnected, true);
  assert.deepEqual(auditLog, ["disconnect:srv-singleton", "connect:srv-singleton:1"]);
}

async function assertRethrowsValidationFromReconnectAttempt(): Promise<void> {
  registerFixtureServer("srv-validation");
  const validationError = new Validation("disconnect rejected", undefined, {
    code: "MCPServerNotRegistered",
  });

  installStubClient({
    connect: (): Promise<void> => Promise.resolve(),
    disconnect: (): Promise<void> => Promise.reject(validationError),
    listTools: (): Promise<readonly []> => Promise.resolve([]),
    listPrompts: (): Promise<readonly []> => Promise.resolve([]),
    listResources: (): Promise<readonly []> => Promise.resolve([]),
    callTool: (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true }),
    readResource: (): Promise<{ readonly content: string; readonly mimeType: string }> =>
      Promise.resolve({ content: "", mimeType: "text/plain" }),
    getPrompt: (): Promise<{ readonly messages: unknown[] }> => Promise.resolve({ messages: [] }),
  });

  await assert.rejects(
    () => reconnect("srv-validation"),
    (error: unknown) => {
      assert.equal((error as { class?: string }).class, "Validation");
      assert.equal(
        (error as { context?: { code?: string } }).context?.code,
        "MCPServerNotRegistered",
      );
      return true;
    },
  );
}

describe("reconnect", () => {
  it("exports the default reconnect policy", () => {
    assertDefaultPolicy();
  });

  it("reconnects on the first successful attempt", async () => {
    await assertReconnectsFirstAttempt();
  });

  it("backs off exponentially between attempts", async () => {
    await assertExponentialBackoff();
  });

  it("throws ProviderTransient/MCPConnectionLost after exhausting attempts", async () => {
    await assertExhaustionError();
  });

  it("preserves the trust decision across reconnect", async () => {
    await assertTrustPreserved();
  });

  it("throws Validation/MCPServerNotRegistered for unknown serverId", async () => {
    await assertUnknownServerError();
  });

  it("emits MCPReconnectAttempt per attempt", async () => {
    await assertReconnectAttemptEvents();
  });

  it("reuses the singleton MCP client when present", async () => {
    await assertReusesSingletonClient();
  });

  it("rethrows validation failures from reconnect attempts", async () => {
    await assertRethrowsValidationFromReconnectAttempt();
  });
});
