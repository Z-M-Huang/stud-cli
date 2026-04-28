import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { compactHistory as CompactHistory } from "../../../src/core/context/compactor.ts";
import type { hasOverflow as HasOverflow } from "../../../src/core/context/memory.ts";
import type { stubBus as StubBus } from "../../helpers/context-fixtures.ts";

interface CompactorModule {
  readonly compactHistory: typeof CompactHistory;
}

interface MemoryModule {
  readonly hasOverflow: typeof HasOverflow;
}

interface FixturesModule {
  readonly stubBus: typeof StubBus;
}

interface AuditRecord {
  readonly class?: string;
  readonly [key: string]: unknown;
}

interface HistoryMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly turnId: string;
}

interface LooseHistoryMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: unknown;
  readonly turnId?: string;
}

interface MockAuditWriter {
  readonly records: readonly AuditRecord[];
  write(record: AuditRecord): Promise<void>;
}

const { compactHistory } = (await import(
  new URL("../../../src/core/context/compactor.ts", import.meta.url).href
)) as CompactorModule;
const { hasOverflow } = (await import(
  new URL("../../../src/core/context/memory.ts", import.meta.url).href
)) as MemoryModule;
const { stubBus } = (await import(
  new URL("../../helpers/context-fixtures.ts", import.meta.url).href
)) as FixturesModule;

function mockAudit(): MockAuditWriter {
  const records: AuditRecord[] = [];
  return {
    get records(): readonly AuditRecord[] {
      return records;
    },
    write(record: AuditRecord): Promise<void> {
      records.push(record);
      return Promise.resolve();
    },
  };
}

function asHistory(
  messages: readonly LooseHistoryMessage[],
): Parameters<typeof compactHistory>[0]["history"] {
  return messages as unknown as Parameters<typeof compactHistory>[0]["history"];
}

describe("hasOverflow", () => {
  it("returns true when tokens > window", () => {
    assert.equal(hasOverflow(101, 100), true);
  });

  it("returns false when tokens <= window", () => {
    assert.equal(hasOverflow(100, 100), false);
  });
});

describe("compactHistory", () => {
  it("summarizes earliest segment; preserves originalTurnIds", async () => {
    const audit = mockAudit();
    const history: readonly HistoryMessage[] = [
      { role: "user", content: "m1", turnId: "t1" },
      { role: "assistant", content: "r1", turnId: "t1" },
      { role: "user", content: "m2", turnId: "t2" },
      { role: "assistant", content: "r2", turnId: "t2" },
      { role: "user", content: "m3", turnId: "t3" },
    ];

    const out = await compactHistory({
      history,
      targetTokens: 4,
      summarize: (messages) =>
        Promise.resolve(
          `SUMMARY[${(messages as readonly { readonly turnId?: string }[]).map((m) => m.turnId).join(",")}]`,
        ),
      audit,
      eventBus: stubBus(),
    });

    assert.ok(out.summarySegments.length > 0);
    assert.ok(out.summarySegments[0]?.originalTurnIds.includes("t1"));
    assert.ok(audit.records.some((record) => record.class === "Compaction"));
  });

  it("returns the compactMessages summary turn plus recent window", async () => {
    const out = await compactHistory({
      history: [
        { role: "user", content: "m1", turnId: "t1" },
        { role: "assistant", content: "r1", turnId: "t1" },
        { role: "user", content: "m2", turnId: "t2" },
      ] as readonly HistoryMessage[],
      targetTokens: 4,
      summarize: () => Promise.resolve("SUMMARY"),
      audit: mockAudit(),
      eventBus: stubBus(),
    });

    assert.deepEqual(
      out.messages.map((message) => message.content),
      ["SUMMARY", "Understood.", "m2"],
    );
  });
});

describe("compactHistory content normalization", () => {
  it("handles primitive and unserializable content while estimating tokens", async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const history = asHistory([
      { role: "user", content: null },
      { role: "assistant", content: 42 },
      { role: "user", content: true },
      { role: "assistant", content: 10n },
      { role: "user", content: cyclic },
    ]);

    const out = await compactHistory({
      history,
      targetTokens: 20,
      summarize: () => Promise.reject(new Error("should not summarize")),
      audit: mockAudit(),
      eventBus: stubBus(),
    });

    assert.equal(out.messages.length, history.length);
  });

  it("normalizes non-string recent content after compaction", async () => {
    const out = await compactHistory({
      history: asHistory([
        { role: "user", content: "older", turnId: "older" },
        { role: "assistant", content: "older response", turnId: "older" },
        { role: "user", content: { purpose: "recent" }, turnId: "recent" },
      ]),
      targetTokens: 4,
      summarize: () => Promise.resolve("SUMMARY"),
      audit: mockAudit(),
      eventBus: stubBus(),
    });

    assert.deepEqual(
      out.messages.map((message) => message.content),
      ["SUMMARY", "Understood.", '{"purpose":"recent"}'],
    );
  });

  it("flattens array content from the compacted recent window", async () => {
    const out = await compactHistory({
      history: asHistory([
        { role: "user", content: "older", turnId: "older" },
        { role: "assistant", content: "older response", turnId: "older" },
        {
          role: "user",
          content: [
            { text: "text part" },
            { content: "content part" },
            { type: "metadata", value: 7 },
          ],
          turnId: "recent",
        },
      ]),
      targetTokens: 5,
      summarize: () => Promise.resolve("SUMMARY"),
      audit: mockAudit(),
      eventBus: stubBus(),
    });

    assert.equal(
      out.messages.at(-1)?.content,
      'text part\ncontent part\n{"type":"metadata","value":7}',
    );
  });
});

describe("compactHistory error and event handling", () => {
  it("post-compaction still over window → Validation/ContextOverflow", async () => {
    const promise = compactHistory({
      history: [
        { role: "user", content: "x".repeat(10_000), turnId: "t1" },
      ] as readonly HistoryMessage[],
      targetTokens: 1,
      summarize: () => Promise.resolve("x".repeat(10_000)),
      audit: mockAudit(),
      eventBus: stubBus(),
    });

    await assert.rejects(promise, (error: unknown) => {
      assert.ok(typeof error === "object" && error !== null);
      const candidate = error as {
        readonly class?: string;
        readonly context?: Readonly<Record<string, unknown>>;
      };
      assert.equal(candidate.class, "Validation");
      assert.equal(candidate.context?.["code"], "ContextOverflow");
      return true;
    });
  });

  it("summarize throws → ProviderTransient/SummarizeFailed", async () => {
    const promise = compactHistory({
      history: [
        { role: "user", content: "m", turnId: "t1" },
        { role: "assistant", content: "r", turnId: "t1" },
        { role: "user", content: "again", turnId: "t2" },
      ] as readonly HistoryMessage[],
      targetTokens: 4,
      summarize: () => Promise.reject(new Error("upstream")),
      audit: mockAudit(),
      eventBus: stubBus(),
    });

    await assert.rejects(promise, (error: unknown) => {
      assert.ok(typeof error === "object" && error !== null);
      const candidate = error as {
        readonly class?: string;
        readonly context?: Readonly<Record<string, unknown>>;
      };
      assert.equal(candidate.class, "ProviderTransient");
      assert.equal(candidate.context?.["code"], "SummarizeFailed");
      return true;
    });
  });

  it("only history is touched — fragments are not passed here", async () => {
    const history: readonly HistoryMessage[] = [
      { role: "user", content: "m1", turnId: "t1" },
      { role: "user", content: "m2", turnId: "t2" },
    ];

    const out = await compactHistory({
      history,
      targetTokens: 4,
      summarize: () => Promise.resolve("S"),
      audit: mockAudit(),
      eventBus: stubBus(),
    });

    assert.ok(out.messages.length >= 1);
  });

  it("emits CompactionInvoked then CompactionPerformed in order", async () => {
    const bus = stubBus();

    await compactHistory({
      history: [
        { role: "user", content: "m1", turnId: "t1" },
        { role: "user", content: "m2", turnId: "t2" },
      ] as readonly HistoryMessage[],
      targetTokens: 4,
      summarize: () => Promise.resolve("S"),
      audit: mockAudit(),
      eventBus: bus,
    });

    const names = bus.events.map((event) => event.name);
    const i = names.indexOf("CompactionInvoked");
    const j = names.indexOf("CompactionPerformed");
    assert.ok(i >= 0);
    assert.ok(j > i);
  });
});
