import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Session } from "../../../src/core/errors/session.js";
import { ToolTerminal } from "../../../src/core/errors/tool-terminal.js";
import { Validation } from "../../../src/core/errors/validation.js";

import type { MCPClient } from "../../../src/core/mcp/client.js";

interface TestBoundResource {
  readonly content: string;
  readonly truncated: boolean;
  readonly taint: "untrusted";
}

interface TestConsumedPrompt {
  readonly taint: "untrusted";
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

const resourceBindingModule: {
  readonly bindResource: (binding: {
    readonly serverId: string;
    readonly uri: string;
    readonly maxBytes: number;
    readonly maxTokens?: number;
  }) => Promise<TestBoundResource>;
} = await import(new URL("../../../src/core/mcp/resource-binding.ts", import.meta.url).href);
const promptConsumeModule: {
  readonly consumePrompt: (args: {
    readonly serverId: string;
    readonly name: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
  }) => Promise<TestConsumedPrompt>;
} = await import(new URL("../../../src/core/mcp/prompt-consume.ts", import.meta.url).href);
const { bindResource } = resourceBindingModule;
const { consumePrompt } = promptConsumeModule;

interface StubClientOptions {
  readonly readResource?: MCPClient["readResource"];
  readonly getPrompt?: MCPClient["getPrompt"];
}

const defaultReadResource: MCPClient["readResource"] = (id, uri) =>
  Promise.resolve().then((): { readonly content: string; readonly mimeType: string } => {
    if (id === "untrusted-srv") {
      throw new Session("MCP server is not trusted", undefined, {
        code: "MCPUntrusted",
        serverId: id,
      });
    }

    if (uri === "file://none") {
      throw new Validation("resource not found", undefined, {
        code: "ResourceMissing",
        serverId: id,
        uri,
      });
    }

    if (uri === "file://empty") {
      throw new ToolTerminal("resource empty", undefined, {
        code: "MCPResourceEmpty",
        serverId: id,
        uri,
      });
    }

    if (uri === "file://big") {
      return { content: "abcdefghijklmnopqrstuvwxyz", mimeType: "text/plain" };
    }

    return { content: "x", mimeType: "text/plain" };
  });

const defaultGetPrompt: MCPClient["getPrompt"] = (id, name) =>
  Promise.resolve().then((): { readonly messages: unknown[] } => {
    if (id === "untrusted-srv") {
      throw new Session("MCP server is not trusted", undefined, {
        code: "MCPUntrusted",
        serverId: id,
      });
    }

    if (name === "no-such") {
      throw new Validation("prompt not found", undefined, {
        code: "PromptMissing",
        serverId: id,
        name,
      });
    }

    if (name === "empty-content") {
      return {
        messages: [{ role: "assistant", content: [{ type: "text", text: "ignored" }] }],
      };
    }

    if (name === "missing-role") {
      return {
        messages: [{ content: { type: "text", text: "hello from prompt" } }],
      };
    }

    return {
      messages: [{ role: "user", content: { type: "text", text: "hello from prompt" } }],
    };
  });

function createStubClient(options: StubClientOptions = {}): MCPClient {
  return {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    listTools: () => Promise.resolve([]),
    listPrompts: () => Promise.resolve([]),
    listResources: () => Promise.resolve([]),
    callTool: () => Promise.resolve({ ok: true }),
    readResource: options.readResource ?? defaultReadResource,
    getPrompt: options.getPrompt ?? defaultGetPrompt,
  };
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      __studCliMcpClient__?: MCPClient;
    }
  ).__studCliMcpClient__ = createStubClient();
});

afterEach(() => {
  delete (
    globalThis as typeof globalThis & {
      __studCliMcpClient__?: MCPClient;
      __studCliMcpClientSingleton__?: MCPClient;
      __studCliMcpResourceAuditHook__?: (event: {
        readonly event: string;
        readonly serverId: string;
        readonly uri: string;
        readonly maxBytes: number;
        readonly maxTokens?: number;
        readonly truncated: boolean;
        readonly mimeType: string;
      }) => void;
      __studCliMcpPromptAuditHook__?: (event: {
        readonly event: string;
        readonly serverId: string;
        readonly name: string;
        readonly messageCount: number;
      }) => void;
    }
  ).__studCliMcpClient__;
  delete (
    globalThis as typeof globalThis & {
      __studCliMcpClient__?: MCPClient;
      __studCliMcpClientSingleton__?: MCPClient;
    }
  ).__studCliMcpClientSingleton__;
  delete (
    globalThis as typeof globalThis & {
      __studCliMcpResourceAuditHook__?: (event: unknown) => void;
    }
  ).__studCliMcpResourceAuditHook__;
  delete (
    globalThis as typeof globalThis & {
      __studCliMcpPromptAuditHook__?: (event: unknown) => void;
    }
  ).__studCliMcpPromptAuditHook__;
});

describe("bindResource", () => {
  it("returns the content tagged untrusted", async () => {
    const r = await bindResource({ serverId: "srv", uri: "file://x", maxBytes: 1_000 });

    assert.equal(r.taint, "untrusted");
    assert.equal(r.content, "x");
    assert.equal(r.truncated, false);
  });

  it("truncates when content exceeds maxBytes", async () => {
    const r = await bindResource({ serverId: "srv", uri: "file://big", maxBytes: 10 });

    assert.equal(r.truncated, true);
    assert.equal(Buffer.byteLength(r.content, "utf8") <= 10, true);
  });

  it("throws Validation/ResourceMissing on a missing URI", async () => {
    await assert.rejects(
      () => bindResource({ serverId: "srv", uri: "file://none", maxBytes: 1_000 }),
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Validation");
        assert.equal((err as { context?: { code?: string } }).context?.code, "ResourceMissing");
        return true;
      },
    );
  });

  it("throws Session/MCPUntrusted when the server is not trusted", async () => {
    await assert.rejects(
      () => bindResource({ serverId: "untrusted-srv", uri: "file://x", maxBytes: 1_000 }),
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Session");
        assert.equal((err as { context?: { code?: string } }).context?.code, "MCPUntrusted");
        return true;
      },
    );
  });

  it("throws Validation/BindingCapExceeded when maxBytes is invalid", async () => {
    await assert.rejects(
      () => bindResource({ serverId: "srv", uri: "file://x", maxBytes: 0 }),
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Validation");
        assert.equal((err as { context?: { code?: string } }).context?.code, "BindingCapExceeded");
        return true;
      },
    );
  });

  it("maps MCPResourceEmpty to Validation/ResourceMissing", async () => {
    await assert.rejects(
      () => bindResource({ serverId: "srv", uri: "file://empty", maxBytes: 1_000 }),
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Validation");
        assert.equal((err as { context?: { code?: string } }).context?.code, "ResourceMissing");
        return true;
      },
    );
  });

  it("emits ResourceBound audit metadata without resolved content", async () => {
    const events: Record<string, unknown>[] = [];
    (
      globalThis as typeof globalThis & {
        __studCliMcpResourceAuditHook__?: (event: Record<string, unknown>) => void;
      }
    ).__studCliMcpResourceAuditHook__ = (event) => {
      events.push(event);
    };

    await bindResource({ serverId: "srv", uri: "file://x", maxBytes: 1_000, maxTokens: 50 });

    assert.deepEqual(events, [
      {
        event: "ResourceBound",
        serverId: "srv",
        uri: "file://x",
        maxBytes: 1_000,
        maxTokens: 50,
        truncated: false,
        mimeType: "text/plain",
      },
    ]);
  });

  it("reuses the singleton MCP client when no explicit test hook is installed", async () => {
    delete (
      globalThis as typeof globalThis & {
        __studCliMcpClient__?: MCPClient;
      }
    ).__studCliMcpClient__;

    const singleton = createStubClient();
    (
      globalThis as typeof globalThis & {
        __studCliMcpClientSingleton__?: MCPClient;
      }
    ).__studCliMcpClientSingleton__ = singleton;

    const r = await bindResource({ serverId: "srv", uri: "file://x", maxBytes: 1_000 });

    assert.equal(r.taint, "untrusted");
  });
});

function registerConsumePromptCoreTests(): void {
  it("returns the prompt messages tagged untrusted", async () => {
    const p = await consumePrompt({ serverId: "srv", name: "example" });

    assert.equal(p.taint, "untrusted");
    assert.equal(p.messages.length > 0, true);
    assert.deepEqual(p.messages[0], { role: "user", content: "hello from prompt" });
  });

  it("throws Validation/PromptMissing when the prompt is absent", async () => {
    await assert.rejects(
      () => consumePrompt({ serverId: "srv", name: "no-such" }),
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Validation");
        assert.equal((err as { context?: { code?: string } }).context?.code, "PromptMissing");
        return true;
      },
    );
  });

  it("throws Session/MCPUntrusted when the prompt server is not trusted", async () => {
    await assert.rejects(
      () => consumePrompt({ serverId: "untrusted-srv", name: "example" }),
      (err: unknown) => {
        assert.equal((err as { class?: string }).class, "Session");
        assert.equal((err as { context?: { code?: string } }).context?.code, "MCPUntrusted");
        return true;
      },
    );
  });

  it("normalizes non-text prompt content to an empty string", async () => {
    const p = await consumePrompt({ serverId: "srv", name: "empty-content" });

    assert.deepEqual(p.messages[0], { role: "assistant", content: "" });
  });

  it("normalizes a missing role to 'unknown'", async () => {
    const p = await consumePrompt({ serverId: "srv", name: "missing-role" });

    assert.deepEqual(p.messages[0], { role: "unknown", content: "hello from prompt" });
  });
}

function registerConsumePromptAuxTests(): void {
  it("normalizes primitive prompt content to an empty string", async () => {
    (
      globalThis as typeof globalThis & {
        __studCliMcpClient__?: MCPClient;
      }
    ).__studCliMcpClient__ = createStubClient({
      getPrompt: () =>
        Promise.resolve({
          messages: [{ role: "assistant", content: "plain-text" }],
        }),
    });

    const p = await consumePrompt({ serverId: "srv", name: "primitive-content" });

    assert.deepEqual(p.messages[0], { role: "assistant", content: "" });
  });

  it("passes a cloned arguments object to the MCP client", async () => {
    let receivedArgs: Readonly<Record<string, unknown>> | undefined;
    (
      globalThis as typeof globalThis & {
        __studCliMcpClient__?: MCPClient;
      }
    ).__studCliMcpClient__ = createStubClient({
      getPrompt: (_serverId, _name, args) => {
        receivedArgs = args;
        return Promise.resolve({
          messages: [{ role: "assistant", content: { type: "text", text: "ok" } }],
        });
      },
    });

    const promptArguments = Object.freeze({ topic: "coverage" });
    await consumePrompt({ serverId: "srv", name: "with-args", arguments: promptArguments });

    assert.deepEqual(receivedArgs, promptArguments);
    assert.notEqual(receivedArgs, promptArguments);
  });

  it("emits PromptConsumed audit metadata without prompt content", async () => {
    const events: Record<string, unknown>[] = [];
    (
      globalThis as typeof globalThis & {
        __studCliMcpPromptAuditHook__?: (event: Record<string, unknown>) => void;
      }
    ).__studCliMcpPromptAuditHook__ = (event) => {
      events.push(event);
    };

    await consumePrompt({ serverId: "srv", name: "example" });

    assert.deepEqual(events, [
      {
        event: "PromptConsumed",
        serverId: "srv",
        name: "example",
        messageCount: 1,
      },
    ]);
  });

  it("reuses the singleton MCP client for prompt consumption", async () => {
    delete (
      globalThis as typeof globalThis & {
        __studCliMcpClient__?: MCPClient;
      }
    ).__studCliMcpClient__;

    const singleton = createStubClient();
    (
      globalThis as typeof globalThis & {
        __studCliMcpClientSingleton__?: MCPClient;
      }
    ).__studCliMcpClientSingleton__ = singleton;

    const p = await consumePrompt({ serverId: "srv", name: "example" });

    assert.equal(p.taint, "untrusted");
  });
}

describe("consumePrompt", () => {
  registerConsumePromptCoreTests();
  registerConsumePromptAuxTests();
});
