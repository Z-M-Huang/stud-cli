import { indexCategories, resolveDependencyIds } from "./dag.js";

import type { DependencyGraph } from "./dag.js";

export function detectCycle(graph: DependencyGraph): readonly string[] | null {
  const categories = indexCategories(graph.nodes);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (nodeId: string): readonly string[] | null => {
    if (visiting.has(nodeId)) {
      const cycleStart = stack.indexOf(nodeId);
      return [...stack.slice(cycleStart), nodeId];
    }

    if (visited.has(nodeId)) {
      return null;
    }

    visiting.add(nodeId);
    stack.push(nodeId);

    const node = graph.nodes.get(nodeId);
    if (node !== undefined) {
      for (const dependencyId of resolveDependencyIds(node, graph.nodes, categories)) {
        const cycle = visit(dependencyId);
        if (cycle !== null) {
          return cycle;
        }
      }
    }

    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
    return null;
  };

  for (const nodeId of [...graph.nodes.keys()].sort()) {
    const cycle = visit(nodeId);
    if (cycle !== null) {
      return cycle;
    }
  }

  return null;
}
