export interface ExtensionNode {
  readonly id: string;
  readonly category: string;
  readonly dependsOn: readonly string[];
}

export interface DependencyGraph {
  readonly nodes: ReadonlyMap<string, ExtensionNode>;
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ResolvedOrder {
  readonly forward: readonly string[];
  readonly reverse: readonly string[];
}

export function buildDag(nodes: readonly ExtensionNode[]): DependencyGraph {
  const nodeMap = new Map<string, ExtensionNode>();
  const edges = new Map<string, ReadonlySet<string>>();
  const byCategory = new Map<string, string[]>();

  for (const node of nodes) {
    nodeMap.set(node.id, node);
    edges.set(node.id, new Set<string>());

    const categoryNodes = byCategory.get(node.category);
    if (categoryNodes === undefined) {
      byCategory.set(node.category, [node.id]);
    } else {
      categoryNodes.push(node.id);
    }
  }

  for (const node of nodes) {
    for (const dependencyId of resolveDependencyIds(node, nodeMap, byCategory)) {
      if (dependencyId === node.id) {
        continue;
      }

      const dependents = edges.get(dependencyId);
      if (dependents !== undefined) {
        (dependents as Set<string>).add(node.id);
      }
    }
  }

  return {
    nodes: nodeMap,
    edges,
  };
}

export function resolveDependencyIds(
  node: ExtensionNode,
  nodes: ReadonlyMap<string, ExtensionNode>,
  byCategory?: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const categories = byCategory ?? indexCategories(nodes);
  const resolved = new Set<string>();

  for (const dependency of node.dependsOn) {
    if (dependency.startsWith("category:")) {
      const category = dependency.slice("category:".length);
      const categoryNodes = categories.get(category);
      if (categoryNodes === undefined) {
        continue;
      }

      for (const dependencyId of categoryNodes) {
        if (dependencyId !== node.id) {
          resolved.add(dependencyId);
        }
      }
      continue;
    }

    if (nodes.has(dependency)) {
      resolved.add(dependency);
    }
  }

  return [...resolved].sort();
}

export function indexCategories(
  nodes: ReadonlyMap<string, ExtensionNode>,
): ReadonlyMap<string, readonly string[]> {
  const byCategory = new Map<string, string[]>();

  for (const node of nodes.values()) {
    const categoryNodes = byCategory.get(node.category);
    if (categoryNodes === undefined) {
      byCategory.set(node.category, [node.id]);
    } else {
      categoryNodes.push(node.id);
    }
  }

  for (const ids of byCategory.values()) {
    ids.sort();
  }

  return byCategory;
}

export { detectCycle } from "./cycle-detector.js";
export { topologicalSort } from "./topological.js";
