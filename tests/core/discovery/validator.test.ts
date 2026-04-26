import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getOutcomeState } from "../../../src/core/discovery/outcome-registrar.js";
import { validate } from "../../../src/core/discovery/validator.js";

import type { JSONSchemaObject } from "../../../src/contracts/meta.js";
import type {
  DiscoveryResult,
  DiscoveredExtension,
  DiscoveryScope,
} from "../../../src/core/discovery/scanner.js";

describe("validate", () => {
  it("runs shape → contractVersion → requiredCoreVersion → configSchema → register in order", async () => {
    const summary = await validate(fixtureDiscovery(validOrderFixtures()));

    assert.equal(summary.loaded.length, 2);
    assert.equal(summary.counts.errors, 0);
    assert.deepEqual(
      summary.outcomes.map((outcome) => outcome.status),
      ["ok", "ok"],
    );
  });

  it("stops before requiredCoreVersion and configSchema when contractVersion fails", async () => {
    const accessLog: string[] = [];
    const summary = await validate(
      fixtureDiscovery([
        withTrackedStageReads(
          fixtureExtension({
            id: "contract-bad",
            category: "tools",
            scope: "global",
            contractVersion: "broken",
            configSchema: validSchema(),
            config: { enabled: true },
          }),
          accessLog,
        ),
      ]),
    );

    assert.equal(summary.outcomes[0]?.failures[0]?.stage, "contractVersion");
    assert.equal(accessLog.includes("configSchema"), false);
  });

  it("stops before configSchema when requiredCoreVersion fails", async () => {
    const accessLog: string[] = [];
    const summary = await validate(
      fixtureDiscovery([
        withTrackedStageReads(
          fixtureExtension({
            id: "core-bad",
            category: "tools",
            scope: "global",
            requiredCoreVersion: ">=2.0.0 <3.0.0",
            configSchema: validSchema(),
            config: { enabled: true },
          }),
          accessLog,
        ),
      ]),
    );

    assert.equal(summary.outcomes[0]?.failures[0]?.stage, "requiredCoreVersion");
    assert.equal(accessLog.includes("configSchema"), false);
  });

  it("disables an extension that fails validation and continues the session", async () => {
    const summary = await validate(fixtureDiscovery(invalidFixtures()));

    const failed = summary.outcomes.find((outcome) => outcome.id === "bad-ext");
    assert.equal(failed?.status, "disabled");
    assert.equal(
      summary.loaded.some((extension) => extension.id === "bad-ext"),
      false,
    );
    assert.equal(
      summary.loaded.some((extension) => extension.id === "good-ext"),
      true,
    );
  });

  it("falls back to the global extension when a project override fails validation", async () => {
    const summary = await validate(fixtureDiscovery(projectOverrideFixtures()));

    const loaded = summary.loaded.find((extension) => extension.id === "foo");
    const failed = summary.outcomes.find(
      (outcome) => outcome.id === "foo" && outcome.scope === "project",
    );

    assert.equal(loaded?.scope, "global");
    assert.equal(failed?.status, "disabled");
    assert.equal(summary.counts.warnings, 1);
    assert.equal(summary.counts.errors, 0);
  });

  it("counts warnings and errors for the TUI startup surface", async () => {
    const summary = await validate(fixtureDiscovery(mixedFixtures()));

    assert.equal(summary.counts.warnings, 1);
    assert.equal(summary.counts.errors, 2);

    const registrar = getOutcomeState();
    assert.deepEqual(registrar.counts, summary.counts);
    assert.equal(registrar.outcomes.length, summary.outcomes.length);
  });

  it("reports failures with a stage name and field path", async () => {
    const summary = await validate(fixtureDiscovery(schemaViolationFixtures()));

    const failure = summary.outcomes[0]?.failures[0];
    assert.equal(failure?.stage, "configSchema");
    assert.equal(failure?.path, "/enabled");
  });
});

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

function validOrderFixtures(): readonly DiscoveredExtension[] {
  return [
    fixtureExtension({
      id: "alpha",
      category: "tools",
      scope: "global",
      configSchema: validSchema(),
      config: { enabled: true },
    }),
    fixtureExtension({ id: "beta", category: "tools", scope: "project" }),
  ];
}

function invalidFixtures(): readonly DiscoveredExtension[] {
  return [
    fixtureExtension({ id: "good-ext", category: "tools", scope: "global" }),
    fixtureExtension({
      id: "bad-ext",
      category: "tools",
      scope: "project",
      contractVersion: "broken",
    }),
  ];
}

function projectOverrideFixtures(): readonly DiscoveredExtension[] {
  return [
    fixtureExtension({ id: "foo", category: "tools", scope: "global" }),
    fixtureExtension({
      id: "foo",
      category: "tools",
      scope: "project",
      configSchema: validSchema(),
      config: { enabled: "yes" },
    }),
  ];
}

function mixedFixtures(): readonly DiscoveredExtension[] {
  return [
    fixtureExtension({ id: "global-ok", category: "tools", scope: "global" }),
    fixtureExtension({
      id: "global-ok",
      category: "tools",
      scope: "project",
      contractVersion: "bad-version",
    }),
    fixtureExtension({
      id: "error-one",
      category: "tools",
      scope: "global",
      requiredCoreVersion: ">=2.0.0 <3.0.0",
    }),
    fixtureExtension({
      id: "error-two",
      category: "tools",
      scope: "project",
      configSchema: validSchema(),
      config: { enabled: "nope" },
    }),
  ];
}

function schemaViolationFixtures(): readonly DiscoveredExtension[] {
  return [
    fixtureExtension({
      id: "schema-bad",
      category: "tools",
      scope: "global",
      configSchema: validSchema(),
      config: {},
    }),
  ];
}

function withTrackedStageReads(
  extension: DiscoveredExtension,
  accessLog: string[],
): DiscoveredExtension {
  const tracked = new Set(["contractVersion", "requiredCoreVersion", "configSchema"]);

  return new Proxy(extension, {
    get(target, property, receiver): unknown {
      if (typeof property === "string" && tracked.has(property)) {
        accessLog.push(property);
      }

      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

describe("validate — semver range operator coverage", () => {
  it("rejects a range whose part does not match the operator regex", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "garbage-range",
          category: "tools",
          scope: "global",
          requiredCoreVersion: "garbage",
        }),
      ]),
    );

    assert.equal(summary.outcomes[0]?.failures[0]?.stage, "requiredCoreVersion");
  });

  it("rejects a range whose '>' bound is not satisfied", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "gt-bound",
          category: "tools",
          scope: "global",
          requiredCoreVersion: ">1.0.0",
        }),
      ]),
    );

    assert.equal(summary.outcomes[0]?.failures[0]?.stage, "requiredCoreVersion");
  });

  it("rejects a range whose '<' bound is not satisfied", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "lt-bound",
          category: "tools",
          scope: "global",
          requiredCoreVersion: "<1.0.0",
        }),
      ]),
    );

    assert.equal(summary.outcomes[0]?.failures[0]?.stage, "requiredCoreVersion");
  });

  it("rejects a range with explicit '=' that does not match", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "eq-mismatch",
          category: "tools",
          scope: "global",
          requiredCoreVersion: "=2.0.0",
        }),
      ]),
    );

    assert.equal(summary.outcomes[0]?.failures[0]?.stage, "requiredCoreVersion");
  });

  it("rejects a range with bare exact version that does not match", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "bare-mismatch",
          category: "tools",
          scope: "global",
          requiredCoreVersion: "2.0.0",
        }),
      ]),
    );

    assert.equal(summary.outcomes[0]?.failures[0]?.stage, "requiredCoreVersion");
  });

  it("rejects a range whose '<=' upper bound is exceeded", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "le-bound",
          category: "tools",
          scope: "global",
          requiredCoreVersion: "<=0.9.0",
        }),
      ]),
    );

    assert.equal(summary.outcomes[0]?.failures[0]?.stage, "requiredCoreVersion");
  });

  it("accepts the inclusive identity range '>=1.0.0 <=1.0.0'", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "exact-pair",
          category: "tools",
          scope: "global",
          requiredCoreVersion: ">=1.0.0 <=1.0.0",
        }),
      ]),
    );

    assert.equal(summary.outcomes[0]?.failures.length, 0);
  });
});

describe("validate — shape failure paths", () => {
  it("reports an empty id as a shape failure with /id path", async () => {
    const summary = await validate(
      fixtureDiscovery([fixtureExtension({ id: "", category: "tools", scope: "global" })]),
    );

    const failure = summary.outcomes[0]?.failures[0];
    assert.equal(failure?.stage, "shape");
    assert.equal(failure?.path, "/id");
  });

  it("reports an empty category as a shape failure with /category path", async () => {
    const summary = await validate(
      fixtureDiscovery([fixtureExtension({ id: "no-category", category: "", scope: "global" })]),
    );

    const failure = summary.outcomes[0]?.failures[0];
    assert.equal(failure?.stage, "shape");
    assert.equal(failure?.path, "/category");
  });

  it("reports an empty contractVersion as a shape failure", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "no-contract-version",
          category: "tools",
          scope: "global",
          contractVersion: "",
        }),
      ]),
    );

    const failure = summary.outcomes[0]?.failures[0];
    assert.equal(failure?.stage, "shape");
    assert.equal(failure?.path, "/contractVersion");
  });

  it("reports an empty requiredCoreVersion as a shape failure", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "no-required-core-version",
          category: "tools",
          scope: "global",
          requiredCoreVersion: "",
        }),
      ]),
    );

    const failure = summary.outcomes[0]?.failures[0];
    assert.equal(failure?.stage, "shape");
    assert.equal(failure?.path, "/requiredCoreVersion");
  });
});

describe("validate — contractVersion compatibility", () => {
  it("reports a valid SemVer triple that does not equal CORE_VERSION", async () => {
    const summary = await validate(
      fixtureDiscovery([
        fixtureExtension({
          id: "valid-but-incompatible",
          category: "tools",
          scope: "global",
          contractVersion: "2.0.0",
        }),
      ]),
    );

    const failure = summary.outcomes[0]?.failures[0];
    assert.equal(failure?.stage, "contractVersion");
    assert.equal(failure?.path, "/contractVersion");
    assert.match(failure?.message ?? "", /incompatible/);
  });
});
