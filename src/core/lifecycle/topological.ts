import { ExtensionHost } from "../errors/extension-host.js";

import { detectCycle } from "./cycle-detector.js";
import { indexCategories, resolveDependencyIds } from "./dag.js";

import type { DependencyGraph, ResolvedOrder } from "./dag.js";

export function topologicalSort(graph: DependencyGraph): ResolvedOrder {
  const categories = indexCategories(graph.nodes);
  const inDegree = new Map<string, number>();

  for (const nodeId of graph.nodes.keys()) {
    inDegree.set(nodeId, 0);
  }

  for (const node of graph.nodes.values()) {
    for (const dependency of node.dependsOn) {
      if (dependency.startsWith("category:")) {
        const category = dependency.slice("category:".length);
        const categoryNodes = categories.get(category);
        if (categoryNodes === undefined || categoryNodes.every((id) => id === node.id)) {
          throw new ExtensionHost(
            `extension '${node.id}' depends on category '${category}' which is not declared`,
            undefined,
            { code: "DependencyMissing", missing: dependency },
          );
        }
        continue;
      }

      if (!graph.nodes.has(dependency)) {
        throw new ExtensionHost(
          `extension '${node.id}' depends on '${dependency}' which is not declared`,
          undefined,
          { code: "DependencyMissing", missing: dependency },
        );
      }
    }

    inDegree.set(node.id, resolveDependencyIds(node, graph.nodes, categories).length);
  }

  const ready = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId)
    .sort();
  const forward: string[] = [];

  while (ready.length > 0) {
    const nextId = ready.shift()!;
    forward.push(nextId);

    const dependents = graph.edges.get(nextId)!;
    for (const dependentId of [...dependents].sort()) {
      const nextDegree = inDegree.get(dependentId)! - 1;
      inDegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        insertLexicographically(ready, dependentId);
      }
    }
  }

  if (forward.length !== graph.nodes.size) {
    const cycle = detectCycle(graph);
    throw new ExtensionHost(`dependency cycle detected: ${(cycle ?? []).join(" -> ")}`, undefined, {
      code: "DependencyCycle",
      cycle: cycle ?? [],
    });
  }

  return {
    forward,
    reverse: [...forward].reverse(),
  };
}

function insertLexicographically(queue: string[], nodeId: string): void {
  if (queue.includes(nodeId)) {
    return;
  }

  queue.push(nodeId);
  queue.sort();
}
