/**
 * Dependency Resolution contract tests (AC-24).
 *
 * Verifies:
 *   1. resolveDependencies — topological init order with lexicographic tie-breaking.
 *   2. resolveDependencies — disposeOrder is the exact reverse of initOrder.
 *   3. resolveDependencies — DependencyCycle failure on a cycle.
 *   4. resolveDependencies — DependencyMissing failure when a declared dep is absent.
 *   5. resolveDependencies — category-kind dependency resolution.
 *   6. extensionDependencySchema fixtures — valid / invalid / worst-plausible via AJV.
 *   7. contractVersion — aligns with wiki page (AC-107 / AC-112 drift discipline).
 *
 * Wiki: contracts/Dependency-Resolution.md + core/Extension-Lifecycle.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  contractVersion,
  extensionDependencySchema,
  resolveDependencies,
} from "../../src/contracts/dependency-resolution.js";

import type {
  DependencyResolutionFailure,
  DependencyResolutionResult,
  ExtensionDependencyDeclaration,
} from "../../src/contracts/dependency-resolution.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResult(
  result: DependencyResolutionResult | DependencyResolutionFailure,
): DependencyResolutionResult {
  if (!result.ok) {
    assert.fail(`expected ok:true but got error: ${result.error.message}`);
  }
  return result;
}

function failResult(
  result: DependencyResolutionResult | DependencyResolutionFailure,
): DependencyResolutionFailure {
  if (result.ok) {
    assert.fail("expected ok:false but resolution succeeded");
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1. Topological init order with lexicographic tie-breaking
// ---------------------------------------------------------------------------

describe("resolveDependencies — topological order", () => {
  it("produces lexicographic order for independent extensions (b, a input → a, b output)", () => {
    const result = okResult(
      resolveDependencies([
        { extId: "b", kind: "Tool", dependsOn: [] },
        { extId: "a", kind: "Tool", dependsOn: [] },
      ]),
    );
    assert.deepEqual([...result.order.initOrder], ["a", "b"]);
  });

  it("places a dependency before its dependent", () => {
    const result = okResult(
      resolveDependencies([
        { extId: "b", kind: "Tool", dependsOn: [] },
        { extId: "a", kind: "Tool", dependsOn: [] },
        { extId: "c", kind: "Tool", dependsOn: [{ kind: "ext", extId: "a" }] },
      ]),
    );
    assert.deepEqual([...result.order.initOrder], ["a", "b", "c"]);
  });

  it("resolves a linear chain in dependency order", () => {
    const decls: ExtensionDependencyDeclaration[] = [
      { extId: "c", kind: "Tool", dependsOn: [{ kind: "ext", extId: "b" }] },
      { extId: "b", kind: "Tool", dependsOn: [{ kind: "ext", extId: "a" }] },
      { extId: "a", kind: "Tool", dependsOn: [] },
    ];
    const result = okResult(resolveDependencies(decls));
    const order = [...result.order.initOrder];
    assert.ok(order.indexOf("a") < order.indexOf("b"), "'a' must come before 'b'");
    assert.ok(order.indexOf("b") < order.indexOf("c"), "'b' must come before 'c'");
  });

  it("resolves a diamond DAG deterministically with lexicographic ordering", () => {
    // a -> b -> d
    // a -> c -> d
    const decls: ExtensionDependencyDeclaration[] = [
      {
        extId: "d",
        kind: "Tool",
        dependsOn: [
          { kind: "ext", extId: "b" },
          { kind: "ext", extId: "c" },
        ],
      },
      { extId: "b", kind: "Tool", dependsOn: [{ kind: "ext", extId: "a" }] },
      { extId: "c", kind: "Tool", dependsOn: [{ kind: "ext", extId: "a" }] },
      { extId: "a", kind: "Tool", dependsOn: [] },
    ];
    const result = okResult(resolveDependencies(decls));
    const order = [...result.order.initOrder];
    assert.equal(order[0], "a", "'a' must be first");
    assert.equal(order[3], "d", "'d' must be last");
    assert.ok(order.indexOf("b") < order.indexOf("c"), "'b' before 'c' (lexicographic tie-break)");
  });

  it("returns an empty initOrder for an empty declarations array", () => {
    const result = okResult(resolveDependencies([]));
    assert.equal(result.order.initOrder.length, 0);
    assert.equal(result.order.disposeOrder.length, 0);
  });

  it("returns a single-element order for a single independent extension", () => {
    const result = okResult(
      resolveDependencies([{ extId: "solo", kind: "Logger", dependsOn: [] }]),
    );
    assert.deepEqual([...result.order.initOrder], ["solo"]);
  });

  it("is deterministic — same input always produces the same output", () => {
    const decls: ExtensionDependencyDeclaration[] = [
      { extId: "z", kind: "Tool", dependsOn: [] },
      { extId: "m", kind: "Tool", dependsOn: [] },
      { extId: "a", kind: "Tool", dependsOn: [] },
      { extId: "q", kind: "Tool", dependsOn: [{ kind: "ext", extId: "m" }] },
    ];
    const r1 = okResult(resolveDependencies(decls));
    const r2 = okResult(resolveDependencies(decls));
    assert.deepEqual([...r1.order.initOrder], [...r2.order.initOrder]);
  });
});

// ---------------------------------------------------------------------------
// 2. disposeOrder is the exact reverse of initOrder
// ---------------------------------------------------------------------------

describe("resolveDependencies — disposeOrder", () => {
  it("is the exact reverse of initOrder for a two-node chain", () => {
    const result = okResult(
      resolveDependencies([
        { extId: "a", kind: "Tool", dependsOn: [] },
        { extId: "b", kind: "Tool", dependsOn: [{ kind: "ext", extId: "a" }] },
      ]),
    );
    const { initOrder, disposeOrder } = result.order;
    assert.deepEqual([...disposeOrder], [...initOrder].reverse());
  });

  it("is the exact reverse of initOrder for four independent extensions", () => {
    const result = okResult(
      resolveDependencies([
        { extId: "d", kind: "Logger", dependsOn: [] },
        { extId: "b", kind: "Logger", dependsOn: [] },
        { extId: "c", kind: "Logger", dependsOn: [] },
        { extId: "a", kind: "Logger", dependsOn: [] },
      ]),
    );
    const { initOrder, disposeOrder } = result.order;
    assert.deepEqual([...disposeOrder], [...initOrder].reverse());
  });
});

// ---------------------------------------------------------------------------
// 3. DependencyCycle failure
// ---------------------------------------------------------------------------

describe("resolveDependencies — DependencyCycle", () => {
  it("returns ok:false with ExtensionHost/DependencyCycle for a two-node cycle", () => {
    const result = failResult(
      resolveDependencies([
        { extId: "a", kind: "Tool", dependsOn: [{ kind: "ext", extId: "b" }] },
        { extId: "b", kind: "Tool", dependsOn: [{ kind: "ext", extId: "a" }] },
      ]),
    );
    assert.equal(result.error.class, "ExtensionHost");
    assert.equal(result.error.context["code"], "DependencyCycle");
  });

  it("names the participating extIds in context.participants", () => {
    const result = failResult(
      resolveDependencies([
        { extId: "a", kind: "Tool", dependsOn: [{ kind: "ext", extId: "b" }] },
        { extId: "b", kind: "Tool", dependsOn: [{ kind: "ext", extId: "a" }] },
      ]),
    );
    const participants = result.error.context["participants"] as string[];
    assert.ok(Array.isArray(participants), "context.participants must be an array");
    assert.ok(participants.includes("a"), "participants must include 'a'");
    assert.ok(participants.includes("b"), "participants must include 'b'");
  });

  it("detects a three-node cycle", () => {
    const result = failResult(
      resolveDependencies([
        { extId: "a", kind: "Tool", dependsOn: [{ kind: "ext", extId: "c" }] },
        { extId: "b", kind: "Tool", dependsOn: [{ kind: "ext", extId: "a" }] },
        { extId: "c", kind: "Tool", dependsOn: [{ kind: "ext", extId: "b" }] },
      ]),
    );
    assert.equal(result.error.context["code"], "DependencyCycle");
  });

  it("does not name acyclic extensions in participants", () => {
    const result = failResult(
      resolveDependencies([
        { extId: "safe", kind: "Logger", dependsOn: [] },
        { extId: "a", kind: "Tool", dependsOn: [{ kind: "ext", extId: "b" }] },
        { extId: "b", kind: "Tool", dependsOn: [{ kind: "ext", extId: "a" }] },
      ]),
    );
    const participants = result.error.context["participants"] as string[];
    assert.ok(!participants.includes("safe"), "'safe' must not be in cycle participants");
  });
});

// ---------------------------------------------------------------------------
// 4. DependencyMissing failure
// ---------------------------------------------------------------------------

describe("resolveDependencies — DependencyMissing", () => {
  it("returns ok:false with DependencyMissing when an ext target is absent", () => {
    const result = failResult(
      resolveDependencies([
        { extId: "a", kind: "Tool", dependsOn: [{ kind: "ext", extId: "ghost" }] },
      ]),
    );
    assert.equal(result.error.class, "ExtensionHost");
    assert.equal(result.error.context["code"], "DependencyMissing");
  });

  it("names the missing extId in context.missingId", () => {
    const result = failResult(
      resolveDependencies([
        { extId: "a", kind: "Tool", dependsOn: [{ kind: "ext", extId: "ghost" }] },
      ]),
    );
    assert.equal(result.error.context["missingId"], "ghost");
  });

  it("names the dependent extId in context.dependentId", () => {
    const result = failResult(
      resolveDependencies([
        { extId: "a", kind: "Tool", dependsOn: [{ kind: "ext", extId: "ghost" }] },
      ]),
    );
    assert.equal(result.error.context["dependentId"], "a");
  });

  it("returns ok:false with DependencyMissing when a category has no loaded members", () => {
    const result = failResult(
      resolveDependencies([
        {
          extId: "a",
          kind: "Tool",
          dependsOn: [{ kind: "category", category: "Logger" }],
        },
      ]),
    );
    assert.equal(result.error.context["code"], "DependencyMissing");
    assert.equal(result.error.context["missingCategory"], "Logger");
  });
});

// ---------------------------------------------------------------------------
// 5. Category-kind dependency resolution
// ---------------------------------------------------------------------------

describe("resolveDependencies — category dependencies", () => {
  it("places all category members before the dependent", () => {
    const result = okResult(
      resolveDependencies([
        { extId: "log-a", kind: "Logger", dependsOn: [] },
        { extId: "log-b", kind: "Logger", dependsOn: [] },
        {
          extId: "tool-x",
          kind: "Tool",
          dependsOn: [{ kind: "category", category: "Logger" }],
        },
      ]),
    );
    const order = [...result.order.initOrder];
    assert.ok(order.indexOf("log-a") < order.indexOf("tool-x"), "'log-a' before 'tool-x'");
    assert.ok(order.indexOf("log-b") < order.indexOf("tool-x"), "'log-b' before 'tool-x'");
  });

  it("does not create a self-dependency when the category contains the dependent itself", () => {
    // tool-a declares dependency on all Tool-category — self-edge is skipped
    const result = okResult(
      resolveDependencies([
        {
          extId: "tool-a",
          kind: "Tool",
          dependsOn: [{ kind: "category", category: "Tool" }],
        },
        { extId: "tool-b", kind: "Tool", dependsOn: [] },
      ]),
    );
    const order = [...result.order.initOrder];
    assert.ok(order.indexOf("tool-b") < order.indexOf("tool-a"), "'tool-b' before 'tool-a'");
  });
});

// ---------------------------------------------------------------------------
// 6. extensionDependencySchema fixtures
// ---------------------------------------------------------------------------

describe("extensionDependencySchema", () => {
  // AJV v6 does not support the 2020-12 $schema URI; strip before compiling.
  const { $schema: _ignored, ...compilableSchema } = extensionDependencySchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid declaration with no dependencies", () => {
    const result = validate({ extId: "a", kind: "Tool", dependsOn: [] });
    assert.equal(
      result,
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("accepts a declaration with an ext-kind dependency", () => {
    const result = validate({
      extId: "b",
      kind: "Tool",
      dependsOn: [{ kind: "ext", extId: "a" }],
    });
    assert.equal(
      result,
      true,
      `Expected ext-kind dep fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("accepts a declaration with a category-kind dependency", () => {
    const result = validate({
      extId: "c",
      kind: "Tool",
      dependsOn: [{ kind: "category", category: "Logger" }],
    });
    assert.equal(
      result,
      true,
      `Expected category-kind dep fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects an unknown category kind and reports the error at /kind", () => {
    const result = validate({ extId: "a", kind: "Bogus", dependsOn: [] });
    assert.equal(result, false, "Expected unknown kind to be rejected");
    const errors = validate.errors ?? [];
    const kindError = errors.find(
      (e) =>
        String((e as { dataPath?: string }).dataPath ?? "").includes("kind") ||
        String((e as { instancePath?: string }).instancePath ?? "").includes("kind") ||
        String(e.schemaPath ?? "").includes("enum"),
    );
    assert.ok(
      kindError != null,
      `Expected an error referencing 'kind'; got ${JSON.stringify(errors)}`,
    );
  });

  it("rejects missing required 'extId' field", () => {
    const result = validate({ kind: "Tool", dependsOn: [] });
    assert.equal(result, false, "Expected missing extId to be rejected");
  });

  it("rejects missing required 'kind' field", () => {
    const result = validate({ extId: "a", dependsOn: [] });
    assert.equal(result, false, "Expected missing kind to be rejected");
  });

  it("rejects missing required 'dependsOn' field", () => {
    const result = validate({ extId: "a", kind: "Tool" });
    assert.equal(result, false, "Expected missing dependsOn to be rejected");
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let rejected: boolean;
    try {
      rejected = !validate({
        extId: "a",
        kind: "Tool",
        dependsOn: [],
        extra: "x".repeat(1_000_000),
      });
    } catch (err) {
      return assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.ok(
      rejected,
      "Expected worst-plausible fixture to be rejected (additionalProperties:false)",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. contractVersion shape (AC-107)
// ---------------------------------------------------------------------------

describe("contractVersion (AC-107)", () => {
  it("exports a semver-shaped contractVersion string", () => {
    assert.match(
      contractVersion,
      /^\d+\.\d+\.\d+$/,
      "contractVersion must be a SemVer string (X.Y.Z)",
    );
  });
});
