import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  configuredProvider,
  resolveActiveEntry,
  resolveActiveModelId,
} from "../../../src/cli/runtime/bootstrap.js";

import type { Settings } from "../../../src/cli/runtime/types.js";

function settingsWith(extra: Settings): Settings {
  return extra;
}

describe("resolveActiveEntry (id-keyed providers)", () => {
  it("returns the entry referenced by active.provider", () => {
    const result = resolveActiveEntry(
      settingsWith({
        providers: {
          bailian: {
            protocol: "openai-compatible",
            apiKeyRef: { kind: "env", name: "X" },
            baseURL: "http://192.168.1.253:8317/v1",
            models: ["a", "b"],
          },
        },
        active: { provider: "bailian" },
      }),
    );
    assert.equal(result?.entryId, "bailian");
    assert.equal(result?.protocolId, "openai-compatible");
  });

  it("falls back to the first key when active.provider is unset", () => {
    const result = resolveActiveEntry(
      settingsWith({
        providers: {
          first: {
            protocol: "anthropic",
            apiKeyRef: { kind: "env", name: "X" },
            models: ["m"],
          },
        },
      }),
    );
    assert.equal(result?.entryId, "first");
  });

  it("returns null when no providers are configured", () => {
    assert.equal(resolveActiveEntry({}), null);
  });

  it("throws Validation/UnknownConfigKey when active.provider does not exist", () => {
    assert.throws(
      () =>
        resolveActiveEntry(
          settingsWith({
            providers: {
              real: {
                protocol: "anthropic",
                apiKeyRef: { kind: "env", name: "X" },
                models: ["m"],
              },
            },
            active: { provider: "ghost" },
          }),
        ),
      (err: unknown) => {
        const ctx = (err as { context?: { code?: unknown; entryId?: unknown } }).context;
        return ctx?.code === "UnknownConfigKey" && ctx?.entryId === "ghost";
      },
    );
  });

  it("throws Validation/UnknownProtocol when the entry's protocol is not bundled", () => {
    assert.throws(
      () =>
        resolveActiveEntry(
          settingsWith({
            providers: {
              ghost: {
                protocol: "weird",
                apiKeyRef: { kind: "env", name: "X" },
                models: ["m"],
              },
            },
            active: { provider: "ghost" },
          }),
        ),
      (err: unknown) =>
        (err as { context?: { code?: unknown } }).context?.code === "UnknownProtocol",
    );
  });

  it("throws Validation/SettingsLegacyShape when an entry has 'model' instead of 'models'", () => {
    assert.throws(
      () =>
        resolveActiveEntry(
          settingsWith({
            providers: {
              legacy: {
                protocol: "openai-compatible",
                apiKeyRef: { kind: "env", name: "X" },
                model: "gpt-4o",
              },
            },
            active: { provider: "legacy" },
          }),
        ),
      (err: unknown) =>
        (err as { context?: { code?: unknown } }).context?.code === "SettingsLegacyShape",
    );
  });
});

describe("resolveActiveModelId (active.model wins, default first models[])", () => {
  const entryConfig = {
    protocol: "openai-compatible" as const,
    apiKeyRef: { kind: "env" as const, name: "X" },
    baseURL: "https://x",
    models: ["a", "b"] as readonly [string, ...string[]],
  };

  it("returns active.model when present in models[]", () => {
    const id = resolveActiveModelId(
      settingsWith({ active: { model: "b" } }),
      "bailian",
      entryConfig,
    );
    assert.equal(id, "b");
  });

  it("returns the first models[] entry when active.model is unset", () => {
    const id = resolveActiveModelId(settingsWith({ active: {} }), "bailian", entryConfig);
    assert.equal(id, "a");
  });

  it("throws Validation/ActiveModelNotInProvider when active.model is unknown", () => {
    assert.throws(
      () => resolveActiveModelId(settingsWith({ active: { model: "c" } }), "bailian", entryConfig),
      (err: unknown) =>
        (err as { context?: { code?: unknown } }).context?.code === "ActiveModelNotInProvider",
    );
  });
});

describe("configuredProvider (end-to-end resolve)", () => {
  it("returns the full ProviderSelection for a valid id-keyed entry", () => {
    const sel = configuredProvider(
      settingsWith({
        providers: {
          bailian: {
            protocol: "openai-compatible",
            apiKeyRef: { kind: "env", name: "X" },
            baseURL: "https://x",
            models: ["qwen", "glm"],
          },
        },
        active: { provider: "bailian", model: "glm" },
      }),
    );
    assert.equal(sel?.entryId, "bailian");
    assert.equal(sel?.protocolId, "openai-compatible");
    assert.equal(sel?.modelId, "glm");
  });

  it("returns null when no providers exist", () => {
    assert.equal(configuredProvider({}), null);
  });
});
