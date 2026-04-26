import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDag, detectCycle, topologicalSort } from "../../../src/core/lifecycle/dag.js";

describe("topologicalSort", () => {
  it("produces dependency-order forward and reverse order matches reverse of forward", () => {
    const nodes = [
      { id: "b", category: "hook", dependsOn: ["a"] },
      { id: "a", category: "hook", dependsOn: [] },
      { id: "c", category: "hook", dependsOn: ["b"] },
    ];

    const graph = buildDag(nodes);
    const order = topologicalSort(graph);

    assert.deepEqual(order.forward, ["a", "b", "c"]);
    assert.deepEqual(order.reverse, ["c", "b", "a"]);
  });

  it("tie-breaks lexicographically when no dependency forces an order", () => {
    const nodes = [
      { id: "z", category: "hook", dependsOn: [] },
      { id: "a", category: "hook", dependsOn: [] },
      { id: "m", category: "hook", dependsOn: [] },
    ];

    const order = topologicalSort(buildDag(nodes));

    assert.deepEqual(order.forward, ["a", "m", "z"]);
  });

  it("resolves category dependencies against all members of a category", () => {
    const nodes = [
      { id: "consumer", category: "tool", dependsOn: ["category:hook"] },
      { id: "alpha", category: "hook", dependsOn: [] },
      { id: "beta", category: "hook", dependsOn: [] },
    ];

    const order = topologicalSort(buildDag(nodes));

    assert.deepEqual(order.forward, ["alpha", "beta", "consumer"]);
    assert.deepEqual(order.reverse, ["consumer", "beta", "alpha"]);
  });
});

describe("detectCycle", () => {
  it("throws ExtensionHost/DependencyCycle on a back-edge", () => {
    const nodes = [
      { id: "a", category: "hook", dependsOn: ["b"] },
      { id: "b", category: "hook", dependsOn: ["a"] },
    ];
    const graph = buildDag(nodes);

    assert.deepEqual(detectCycle(graph), ["a", "b", "a"]);
    assert.throws(() => topologicalSort(graph), {
      class: "ExtensionHost",
      context: { code: "DependencyCycle", cycle: ["a", "b", "a"] },
    });
  });

  it("throws ExtensionHost/DependencyMissing when a dependency is absent", () => {
    const nodes = [{ id: "a", category: "hook", dependsOn: ["ghost"] }];
    const graph = buildDag(nodes);

    assert.throws(() => topologicalSort(graph), {
      class: "ExtensionHost",
      context: { code: "DependencyMissing", missing: "ghost" },
    });
  });

  it("throws ExtensionHost/DependencyMissing when a category dependency is absent", () => {
    const nodes = [{ id: "a", category: "hook", dependsOn: ["category:tool"] }];
    const graph = buildDag(nodes);

    assert.throws(() => topologicalSort(graph), {
      class: "ExtensionHost",
      context: { code: "DependencyMissing", missing: "category:tool" },
    });
  });

  it("throws ExtensionHost/DependencyMissing when a category dependency only resolves to itself", () => {
    const nodes = [{ id: "solo", category: "hook", dependsOn: ["category:hook"] }];
    const graph = buildDag(nodes);

    assert.throws(() => topologicalSort(graph), {
      class: "ExtensionHost",
      context: { code: "DependencyMissing", missing: "category:hook" },
    });
  });

  it("deduplicates overlapping direct and category dependencies", () => {
    const nodes = [
      { id: "consumer", category: "tool", dependsOn: ["alpha", "category:hook"] },
      { id: "alpha", category: "hook", dependsOn: [] },
      { id: "beta", category: "hook", dependsOn: [] },
    ];

    const order = topologicalSort(buildDag(nodes));

    assert.deepEqual(order.forward, ["alpha", "beta", "consumer"]);
    assert.deepEqual(order.reverse, ["consumer", "beta", "alpha"]);
  });

  it("supports an empty graph", () => {
    const order = topologicalSort(buildDag([]));

    assert.deepEqual(order.forward, []);
    assert.deepEqual(order.reverse, []);
  });

  it("falls back to an empty cycle path when given an inconsistent acyclic graph", () => {
    const graph = {
      nodes: new Map([
        ["a", { id: "a", category: "hook", dependsOn: [] }],
        ["b", { id: "b", category: "hook", dependsOn: ["a"] }],
      ]),
      edges: new Map([
        ["a", new Set<string>()],
        ["b", new Set<string>()],
      ]),
    };

    assert.throws(() => topologicalSort(graph), {
      class: "ExtensionHost",
      context: { code: "DependencyCycle", cycle: [] },
    });
  });

  it("returns null when the graph is acyclic", () => {
    const nodes = [
      { id: "a", category: "hook", dependsOn: [] },
      { id: "b", category: "hook", dependsOn: ["a"] },
    ];

    assert.equal(detectCycle(buildDag(nodes)), null);
  });
});
