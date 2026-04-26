import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runDiscovery } from "../../src/core/discovery/run.js";
import { createEventBus } from "../../src/core/events/bus.js";
import { diffSequences, hashLoadOrder, replayEvents } from "../helpers/determinism.js";

describe("AC-73: deterministic discovery", () => {
  it("two runs of the same extension set produce byte-identical init order", async () => {
    const first = await runDiscovery({ fixture: "reference-set" });
    const second = await runDiscovery({ fixture: "reference-set" });

    assert.equal(hashLoadOrder(first.initOrder), hashLoadOrder(second.initOrder));
  });

  it("hook slot ordering is stable across runs", async () => {
    const first = await runDiscovery({ fixture: "reference-set" });
    const second = await runDiscovery({ fixture: "reference-set" });

    assert.deepEqual(diffSequences(first.hookSlotOrder, second.hookSlotOrder), []);
  });
});

describe("AC-41: deterministic event and command delivery", () => {
  it("subscribers receive events in registration order", () => {
    const bus = createEventBus({ monotonic: () => 1n });
    const seen: string[] = [];

    bus.on("StagePreFired", () => seen.push("A"));
    bus.on("StagePreFired", () => seen.push("B"));
    bus.on("StagePreFired", () => seen.push("C"));
    bus.emit({ name: "StagePreFired", correlationId: "c", monotonicTs: 1n, payload: {} });

    assert.deepEqual(seen, ["A", "B", "C"]);
  });

  it("delivery is single-threaded per session (no interleaving across subscribers)", () => {
    const bus = createEventBus({ monotonic: () => 1n });
    const log: string[] = [];

    bus.on("StagePreFired", () => {
      log.push("A-start");
      log.push("A-end");
    });
    bus.on("StagePreFired", () => {
      log.push("B-start");
      log.push("B-end");
    });
    bus.emit({ name: "StagePreFired", correlationId: "c", monotonicTs: 1n, payload: {} });

    assert.deepEqual(log, ["A-start", "A-end", "B-start", "B-end"]);
  });

  it("replayed event streams match byte-for-byte across two runs", () => {
    const bus1 = createEventBus({ monotonic: () => 1n });
    const bus2 = createEventBus({ monotonic: () => 1n });
    const stream = [
      { name: "SessionTurnStart", correlationId: "turn", monotonicTs: 1n, payload: {} },
      { name: "StagePreFired", correlationId: "turn", monotonicTs: 2n, payload: {} },
    ];

    const seq1 = replayEvents(bus1, stream);
    const seq2 = replayEvents(bus2, stream);

    assert.deepEqual(seq1, seq2);
  });

  it("non-determinism is confined to sampling/time/compaction surfaces", async () => {
    const first = await runDiscovery({ fixture: "reference-set" });
    const second = await runDiscovery({ fixture: "reference-set" });
    const differences = diffSequences(first.allObservations, second.allObservations);

    assert.equal(
      differences.every((d: string) =>
        ["sampling", "time", "compaction"].some((surface) => d.includes(surface)),
      ),
      true,
    );
    assert.deepEqual(differences, []);
  });
});
