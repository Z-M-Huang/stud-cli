/**
 *  + Compaction-Warning flow.
 *
 * Drives the real `compactHistory` (`src/core/context/compactor.ts`) and
 * captures bus events + audit records to assert:
 *
 *   1. CompactionInvoked fires before compaction runs (the "warning"
 *      threshold event).
 *   2. CompactionPerformed fires when compaction completes; the audit
 *      writer records `class: "Compaction"`.
 *   3. ContextOverflow throws (`Validation/ContextOverflow`) when the
 *      compacted history still exceeds the target budget.
 *
 * Wiki: flows/Compaction-Warning.md + context/Compaction-and-Memory.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compactHistory } from "../../src/core/context/compactor.js";
import { createEventBus } from "../../src/core/events/bus.js";

import type { ChatMessage } from "../../src/core/context/assembler.js";

function makeBus() {
  let tick = 0n;
  return createEventBus({ monotonic: () => ++tick });
}

function recordingAudit() {
  const records: Readonly<Record<string, unknown>>[] = [];
  return {
    records,
    writer: {
      write: (r: Readonly<Record<string, unknown>>) => (records.push(r), Promise.resolve()),
    },
  };
}

function bigHistory(): ChatMessage[] {
  // Each message contributes ~10 tokens (10k chars / 1000), so 5 messages
  // totals ~50 tokens. With targetTokens=25 the compactor must summarize
  // while still leaving room for agentool's preserved recent window.
  return [
    { role: "user", content: "x".repeat(10_000) },
    { role: "assistant", content: "y".repeat(10_000) },
    { role: "user", content: "z".repeat(10_000) },
    { role: "assistant", content: "w".repeat(10_000) },
    { role: "user", content: "q".repeat(10_000) },
  ];
}

describe("Compaction-Warning + CompactionPerformed events", () => {
  it("CompactionInvoked event fires before any compaction work", async () => {
    const bus = makeBus();
    const audit = recordingAudit();
    const events: string[] = [];
    bus.onAny((ev) => events.push(ev.name));

    await compactHistory({
      history: [{ role: "user", content: "tiny" }],
      targetTokens: 1000,
      summarize: () => Promise.resolve("summary"),
      audit: audit.writer,
      eventBus: bus,
    });
    assert.equal(events[0], "CompactionInvoked");
  });

  it("CompactionPerformed event + audit record fire when no compaction was needed (idempotent)", async () => {
    const bus = makeBus();
    const audit = recordingAudit();
    const events: string[] = [];
    bus.onAny((ev) => events.push(ev.name));

    await compactHistory({
      history: [{ role: "user", content: "tiny" }],
      targetTokens: 1000,
      summarize: () => Promise.resolve("summary"),
      audit: audit.writer,
      eventBus: bus,
    });
    assert.equal(events.includes("CompactionPerformed"), true);
    assert.equal(audit.records[0]?.["class"], "Compaction");
    assert.equal(audit.records[0]?.["segmentsCompacted"], 0);
  });

  it("compaction summarises history when totalTokens exceeds the target", async () => {
    const bus = makeBus();
    const audit = recordingAudit();
    let summarizeCalls = 0;
    const result = await compactHistory({
      history: bigHistory(),
      targetTokens: 25,
      summarize: (msgs) => {
        summarizeCalls += 1;
        return Promise.resolve(`summary of ${msgs.length} messages`);
      },
      audit: audit.writer,
      eventBus: bus,
    });
    assert.ok(summarizeCalls >= 1, "summarize must be invoked");
    assert.ok(result.summarySegments.length >= 1);
    assert.ok(audit.records.some((r) => Number(r["segmentsCompacted"]) > 0));
  });

  it("ContextOverflow throws (Validation/ContextOverflow) when target is impossible", async () => {
    const bus = makeBus();
    const audit = recordingAudit();
    let threw: { class: string | undefined; code: string | undefined } | null = null;
    try {
      await compactHistory({
        history: bigHistory(),
        targetTokens: 1, // impossibly small — even after summarising, exceed
        summarize: () => Promise.resolve("x".repeat(50_000)), // bigger summary
        audit: audit.writer,
        eventBus: bus,
      });
    } catch (err) {
      threw = {
        class: (err as { class?: string }).class,
        code: (err as { context?: { code?: string } }).context?.code,
      };
    }
    assert.equal(threw?.class, "Validation");
    assert.equal(threw?.code, "ContextOverflow");
  });

  it("validates targetTokens is a positive integer (Validation/ContextOverflow)", async () => {
    const bus = makeBus();
    const audit = recordingAudit();
    let threw: { code: string | undefined } | null = null;
    try {
      await compactHistory({
        history: [],
        targetTokens: -1,
        summarize: () => Promise.resolve("x"),
        audit: audit.writer,
        eventBus: bus,
      });
    } catch (err) {
      threw = { code: (err as { context?: { code?: string } }).context?.code };
    }
    assert.equal(threw?.code, "ContextOverflow");
  });
});
