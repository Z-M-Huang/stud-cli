import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validate } from "../../../src/core/discovery/validator.js";

import type { JSONSchemaObject } from "../../../src/contracts/meta.js";
import type {
  DiscoveryResult,
  DiscoveredExtension,
  DiscoveryScope,
} from "../../../src/core/discovery/scanner.js";

function fixtureDiscovery(extensions: readonly DiscoveredExtension[]): DiscoveryResult {
  return {
    extensions,
    orderingManifests: new Map(),
  };
}

function fixtureExtension(args: {
  readonly id: string;
  readonly category: string;
  readonly scope: DiscoveryScope;
  readonly contractVersion?: string;
  readonly requiredCoreVersion?: string;
  readonly configSchema?: JSONSchemaObject;
  readonly config?: unknown;
}): DiscoveredExtension {
  return {
    id: args.id,
    category: args.category,
    contractVersion: args.contractVersion ?? "1.0.0",
    requiredCoreVersion: args.requiredCoreVersion ?? ">=1.0.0 <2.0.0",
    scope: args.scope,
    manifestPath: `/fixtures/${args.scope}/${args.category}/${args.id}/manifest.json`,
    ...(args.configSchema !== undefined ? { configSchema: args.configSchema } : {}),
    ...("config" in args ? { config: args.config } : {}),
  };
}

function validSchema(): JSONSchemaObject {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["enabled"],
    properties: {
      enabled: { type: "boolean" },
    },
  };
}

describe("validate — configSchema invariants: shape and compile errors", () => {
  it("rejects a non-object configSchema with a typed failure", async () => {
    const summary = await validate(
      fixtureDiscovery([
        {
          id: "bad-schema-shape",
          category: "tools",
          contractVersion: "1.0.0",
          requiredCoreVersion: ">=1.0.0 <2.0.0",
          scope: "global",
          manifestPath: "/fixtures/global/tools/bad-schema-shape/manifest.json",
          configSchema: [] as unknown as JSONSchemaObject,
          config: { enabled: true },
        },
      ]),
    );

    const failure = summary.outcomes[0]?.failures[0];
    assert.equal(failure?.stage, "configSchema");
    assert.equal(failure?.path, "/configSchema");
  });

  it("propagates an internal pipeline failure when ajv compile throws", async () => {
    let caught: unknown;
    try {
      await validate(
        fixtureDiscovery([
          fixtureExtension({
            id: "broken-schema",
            category: "tools",
            scope: "global",
            configSchema: {
              type: "object",
              required: "not-an-array",
            } as unknown as JSONSchemaObject,
            config: {},
          }),
        ]),
      );
    } catch (error) {
      caught = error;
    }

    assert.ok(caught !== undefined);
    assert.equal((caught as { class?: string }).class, "Validation");
    assert.equal(
      (caught as { context?: { code?: string } }).context?.code,
      "InternalPipelineFailure",
    );
  });
});

describe("validate — configSchema invariants: rejection paths", () => {
  it("reports the additionalProperty path when the schema rejects unknown keys", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "extra-prop",
          category: "tools",
          scope: "global",
          configSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
            properties: { enabled: { type: "boolean" } },
          },
          config: { enabled: true, surprise: 1 },
        }),
      ]),
    );

    const failure = summary.outcomes[0]?.failures[0];
    assert.equal(failure?.stage, "configSchema");
    assert.equal(failure?.path, "/surprise");
  });

  it("returns no path when the schema rejects with a root-only failure", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "root-type-mismatch",
          category: "tools",
          scope: "global",
          configSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
          },
          config: "not-an-object",
        }),
      ]),
    );

    const failure = summary.outcomes[0]?.failures[0];
    assert.equal(failure?.stage, "configSchema");
    assert.equal(failure?.path, undefined);
    assert.ok((failure?.message ?? "").length > 0);
  });
});

describe("validate — configSchema invariants: severity and semver edges", () => {
  it("downgrades a configSchema failure to warning when a global fallback is loaded", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({ id: "fb", category: "tools", scope: "global" }),
        fixtureExtension({
          id: "fb",
          category: "tools",
          scope: "project",
          configSchema: validSchema(),
          config: { enabled: "no" },
        }),
      ]),
    );

    const failed = summary.outcomes.find(
      (outcome) => outcome.id === "fb" && outcome.scope === "project",
    );
    assert.equal(failed?.failures[0]?.severity, "warning");
  });

  it("compares semver minor/patch deltas via '<=' and '>=' bounds", async () => {
    const summaryHi = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "patch-hi",
          category: "tools",
          scope: "global",
          requiredCoreVersion: "<=1.0.5",
        }),
      ]),
    );
    assert.equal(summaryHi.outcomes[0]?.failures.length, 0);

    const summaryEq = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "patch-eq",
          category: "tools",
          scope: "global",
          requiredCoreVersion: ">=0.5.5",
        }),
      ]),
    );
    assert.equal(summaryEq.outcomes[0]?.failures.length, 0);
  });

  it("uses the dataPath fast path in toJsonPointer when Ajv reports a leaf", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "leaf-mismatch",
          category: "tools",
          scope: "global",
          configSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { count: { type: "integer" } },
          },
          config: { count: "abc" },
        }),
      ]),
    );

    const failure = summary.outcomes[0]?.failures[0];
    assert.equal(failure?.stage, "configSchema");
    assert.match(failure?.path ?? "", /count$/);
  });
});
