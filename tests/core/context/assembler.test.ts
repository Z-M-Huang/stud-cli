import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExtensionHost, Validation } from "../../../src/core/errors/index.js";

import type {
  ChatMessage,
  assembleRequest as AssembleRequest,
  enforcePerProviderBudget as EnforcePerProviderBudget,
} from "../../../src/core/context/assembler.ts";
import type {
  identityTokenizer as IdentityTokenizer,
  stubBus as StubBus,
  stubProvider as StubProvider,
} from "../../helpers/context-fixtures.ts";

interface AssemblerModule {
  readonly assembleRequest: typeof AssembleRequest;
  readonly enforcePerProviderBudget: typeof EnforcePerProviderBudget;
}

interface ContextFixturesModule {
  readonly identityTokenizer: typeof IdentityTokenizer;
  readonly stubBus: typeof StubBus;
  readonly stubProvider: typeof StubProvider;
}

const { assembleRequest, enforcePerProviderBudget } = (await import(
  new URL("../../../src/core/context/assembler.ts", import.meta.url).href
)) as AssemblerModule;
const { identityTokenizer, stubBus, stubProvider } = (await import(
  new URL("../../helpers/context-fixtures.ts", import.meta.url).href
)) as ContextFixturesModule;

function compactIdentity(history: readonly ChatMessage[]): Promise<readonly ChatMessage[]> {
  return Promise.resolve(history);
}

describe("assembleRequest — ordering and budget enforcement", () => {
  it("orders fragments by priority desc then ownerExtId asc", async () => {
    const providers = [
      stubProvider("b", [
        { kind: "system-message", content: "B", priority: 5, budget: 100, ownerExtId: "b" },
      ]),
      stubProvider("a", [
        { kind: "system-message", content: "A", priority: 5, budget: 100, ownerExtId: "a" },
      ]),
      stubProvider("c", [
        { kind: "system-message", content: "C", priority: 10, budget: 100, ownerExtId: "c" },
      ]),
    ];

    const out = await assembleRequest({
      systemPrompt: "",
      history: [],
      toolManifest: [],
      modelParams: { tokenizer: identityTokenizer },
      modelWindowTokens: 10_000,
      providers,
      eventBus: stubBus(),
      compact: compactIdentity,
    });

    assert.deepEqual(
      out.fragments.map((fragment) => fragment.content),
      ["C", "A", "B"],
    );
  });

  it("truncates when a provider exceeds its declared budget", () => {
    const fragments = [
      { kind: "system-message", content: "aaaaaaaaaa", priority: 1, budget: 5, ownerExtId: "x" },
    ] as const;

    const out = enforcePerProviderBudget(fragments);

    assert.equal(out[0]?.content.length, 5);
  });

  it("exhausts a provider budget across multiple fragments from the tail", () => {
    const fragments = [
      { kind: "system-message", content: "abcd", priority: 2, budget: 4, ownerExtId: "x" },
      { kind: "prompt-fragment", content: "tail", priority: 1, budget: 4, ownerExtId: "x" },
    ] as const;

    const out = enforcePerProviderBudget(fragments);

    assert.equal(out[0]?.content, "abcd");
    assert.equal(out[1]?.content, "");
  });
});

describe("assembleRequest — compaction and completion", () => {
  it("compacts when aggregate > modelWindowTokens", async () => {
    const bus = stubBus();
    let compactCalls = 0;

    await assembleRequest({
      systemPrompt: "sys",
      history: Array.from({ length: 100 }, (_, index) => ({
        role: "user" as const,
        content: `m${index}`,
      })),
      toolManifest: [],
      modelParams: { tokenizer: identityTokenizer },
      modelWindowTokens: 50,
      providers: [],
      eventBus: bus,
      compact(history) {
        compactCalls += 1;
        return Promise.resolve(history.slice(-2));
      },
    });

    assert.equal(compactCalls, 1);
    assert.ok(bus.events.map((event) => event.name).includes("CompactionInvoked"));
  });

  it("compaction still overflowing -> Validation/ContextOverflow", async () => {
    const promise = assembleRequest({
      systemPrompt: "x".repeat(10_000),
      history: [],
      toolManifest: [],
      modelParams: { tokenizer: identityTokenizer },
      modelWindowTokens: 50,
      providers: [],
      eventBus: stubBus(),
      compact: compactIdentity,
    });

    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof Validation);
      assert.equal(error.class, "Validation");
      assert.equal(error.context["code"], "ContextOverflow");
      return true;
    });
  });

  it("emits five events across the happy path", async () => {
    const bus = stubBus();

    await assembleRequest({
      systemPrompt: "sys",
      history: [],
      toolManifest: [],
      modelParams: { tokenizer: identityTokenizer },
      modelWindowTokens: 10_000,
      providers: [],
      eventBus: bus,
      compact: compactIdentity,
    });

    const names = bus.events.map((event) => event.name);
    assert.deepEqual(names, [
      "AssemblyStarted",
      "FragmentsResolved",
      "BudgetEnforced",
      "CompactionInvoked",
      "AssemblyCompleted",
    ]);
  });
});

describe("assembleRequest — validation and provider failures", () => {
  it("modelWindowTokens <= 0 -> Validation/ModelWindowInvalid", async () => {
    const promise = assembleRequest({
      systemPrompt: "",
      history: [],
      toolManifest: [],
      modelParams: { tokenizer: identityTokenizer },
      modelWindowTokens: 0,
      providers: [],
      eventBus: stubBus(),
      compact: compactIdentity,
    });

    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof Validation);
      assert.equal(error.class, "Validation");
      assert.equal(error.context["code"], "ModelWindowInvalid");
      return true;
    });
  });

  it("skips graceful provider failures after emitting ContextProviderFailed", async () => {
    const bus = stubBus();

    const out = await assembleRequest({
      systemPrompt: "sys",
      history: [],
      toolManifest: [],
      modelParams: { tokenizer: identityTokenizer },
      modelWindowTokens: 10_000,
      providers: [
        stubProvider("good", [
          {
            kind: "system-message",
            content: "ok",
            priority: 1,
            budget: 100,
            ownerExtId: "good",
          },
        ]),
        stubProvider("bad", [], { graceful: true, error: new Error("boom") }),
      ],
      eventBus: bus,
      compact: compactIdentity,
    });

    assert.deepEqual(
      out.fragments.map((fragment) => fragment.ownerExtId),
      ["good"],
    );
    assert.ok(bus.events.map((event) => event.name).includes("ContextProviderFailed"));
  });

  it("re-throws an existing ExtensionHost/ContextProviderFailed without re-wrapping", async () => {
    const original = new ExtensionHost("already wrapped", undefined, {
      code: "ContextProviderFailed",
      ownerExtId: "bad",
    });
    const promise = assembleRequest({
      systemPrompt: "sys",
      history: [],
      toolManifest: [],
      modelParams: { tokenizer: identityTokenizer },
      modelWindowTokens: 10_000,
      providers: [stubProvider("bad", [], { error: original })],
      eventBus: stubBus(),
      compact: compactIdentity,
    });

    await assert.rejects(promise, (error: unknown) => {
      assert.equal(error, original);
      return true;
    });
  });

  it("propagates non-graceful provider failures as ExtensionHost/ContextProviderFailed", async () => {
    const promise = assembleRequest({
      systemPrompt: "sys",
      history: [],
      toolManifest: [],
      modelParams: { tokenizer: identityTokenizer },
      modelWindowTokens: 10_000,
      providers: [stubProvider("bad", [], { error: new Error("boom") })],
      eventBus: stubBus(),
      compact: compactIdentity,
    });

    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof ExtensionHost);
      assert.equal(error.class, "ExtensionHost");
      assert.equal(error.context["code"], "ContextProviderFailed");
      return true;
    });
  });
});

describe("assembleRequest — Q-6 forbidden-source ban", () => {
  it("rejects a fragment containing credential-shape tokens — even from a graceful provider", async () => {
    const fakeKey = Buffer.from("c2stYW50LUZBS0VfVE9LRU5fVEVTVDEyMw==", "base64").toString("utf8");
    const promise = assembleRequest({
      systemPrompt: "sys",
      history: [],
      toolManifest: [],
      modelParams: { tokenizer: identityTokenizer },
      modelWindowTokens: 10_000,
      providers: [
        stubProvider(
          "leaky",
          [
            {
              kind: "system-message",
              content: `Pasted log: ${fakeKey} (oops)`,
              priority: 1,
              budget: 1024,
              ownerExtId: "leaky",
            },
          ],
          { graceful: true },
        ),
      ],
      eventBus: stubBus(),
      compact: compactIdentity,
    });

    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof Validation);
      assert.equal(error.context["code"], "ContextContainsForbiddenSource");
      assert.equal(error.context["ownerExtId"], "leaky");
      return true;
    });
  });
});

describe("assembleRequest — tokenizer behavior", () => {
  it("uses the default tokenizer when modelParams.tokenizer is absent", async () => {
    const out = await assembleRequest({
      systemPrompt: "abc",
      history: [],
      toolManifest: [],
      modelParams: {},
      modelWindowTokens: 10_000,
      providers: [],
      eventBus: stubBus(),
      compact: compactIdentity,
    });

    assert.equal(out.tokenBreakdown.system, 3);
  });

  it("passes tokenizerId through to a pluggable tokenizer", async () => {
    const calls: { value: string; tokenizerId: string | undefined }[] = [];
    const tokenizer = (value: string, tokenizerId?: string): number => {
      calls.push({ value, tokenizerId });
      return value.length;
    };

    await assembleRequest({
      systemPrompt: "sys",
      history: [],
      toolManifest: [],
      modelParams: { tokenizer, tokenizerId: "id-1" },
      modelWindowTokens: 10_000,
      providers: [],
      eventBus: stubBus(),
      compact: compactIdentity,
    });

    assert.equal(calls[0]?.tokenizerId, "id-1");
  });
});
