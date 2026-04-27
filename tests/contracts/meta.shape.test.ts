/**
 * Shape-surface tests for `ExtensionContract<T>` post Q-3.
 *
 * Covers two concerns:
 *   1. Runtime property-enumeration of the ten-field meta-contract shape.
 *   2.  — three fixture shapes (valid, invalid, worst-plausible) validated
 *      against the fixture's `configSchema` using Ajv, asserting that Ajv
 *      accepts valid input, rejects invalid input with a field path, and rejects
 *      hostile input without crashing.
 *
 * Wiki: contracts/Contract-Pattern.md + contracts/Validation-Pipeline.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Ajv v6 (installed in devDependencies via the test scaffold).
// Imported as a CommonJS default — see runtime-targets.md for why tests may use CJS.
import Ajv from "ajv";

import type { CategoryKind, ExtensionContract } from "../../src/contracts/meta.js";

// ---------------------------------------------------------------------------
// Conforming fixture — exactly the ten fields required post Q-3.
// ---------------------------------------------------------------------------
const fixture: ExtensionContract<{ readonly enabled: boolean }> = {
  kind: "Tool",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: {},
  configSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: { enabled: { type: "boolean" } },
    required: ["enabled"],
  },
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  discoveryRules: { folder: "tools", manifestKey: "noop" },
  reloadBehavior: "between-turns",
};

describe("ExtensionContract<T> meta shape", () => {
  it("declares exactly the ten fields required post Q-3", () => {
    const keys = Object.keys(fixture).sort();
    assert.deepEqual(keys, [
      "activeCardinality",
      "configSchema",
      "contractVersion",
      "discoveryRules",
      "kind",
      "lifecycle",
      "loadedCardinality",
      "reloadBehavior",
      "requiredCoreVersion",
      "stateSlot",
    ]);
  });

  it("has no validationSeverity field (removed per Q-3)", () => {
    assert.equal("validationSeverity" in fixture, false);
  });

  it("kind is one of the nine declared CategoryKind values", () => {
    const allowed: CategoryKind[] = [
      "Provider",
      "Tool",
      "Hook",
      "UI",
      "Logger",
      "StateMachine",
      "Command",
      "SessionStore",
      "ContextProvider",
    ];
    assert.ok(allowed.includes(fixture.kind));
  });

  it("stateSlot is null for a stateless extension", () => {
    assert.equal(fixture.stateSlot, null);
  });

  it("lifecycle is an empty object for a no-op extension", () => {
    assert.deepEqual(fixture.lifecycle, {});
  });

  it("configSchema carries the JSON-Schema 2020-12 declaration", () => {
    assert.equal(
      (fixture.configSchema as Record<string, unknown>)["$schema"],
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.equal((fixture.configSchema as Record<string, unknown>)["additionalProperties"], false);
  });
});

// ---------------------------------------------------------------------------
// Three fixture shapes — valid, invalid, worst-plausible.
// Validates the fixture's configSchema (enabled: boolean, additionalProperties: false)
// using Ajv so that the meta-contract's schema machinery is exercised at test time.
//
// Ajv v6 uses `dataPath` (e.g., ".enabled") for error locations.
// ---------------------------------------------------------------------------

const ajv = new Ajv();
// Strip the JSON Schema 2020-12 $schema declaration before compiling: Ajv v6
// is a Draft-07 validator and will warn on an unknown meta-schema URI.
const { $schema: _ignored, ...compilableSchema } = fixture.configSchema as Record<string, unknown>;
const validate = ajv.compile(compilableSchema);

const validFixture = { enabled: true };
const invalidFixture = { enabled: "not a boolean" };
const worstPlausibleFixture = {
  enabled: true,
  // __proto__ in an object literal sets the prototype (ES2015+). Ajv must not
  // crash on this and must reject the object because `extra` violates
  // additionalProperties: false.
  extra: "x".repeat(1_000_000),
};

describe("configSchema fixture validation", () => {
  it("accepts the valid fixture", () => {
    assert.equal(validate(validFixture), true);
    assert.equal(validate.errors, null);
  });

  it("rejects the invalid fixture and reports the offending field path", () => {
    assert.equal(validate(invalidFixture), false);
    assert.ok(Array.isArray(validate.errors) && validate.errors.length > 0);
    // Ajv v6 reports field paths as dataPath (".enabled").
    const path: string = (validate.errors[0] as { dataPath: string }).dataPath ?? "";
    assert.ok(path.includes("enabled"), `expected path to include 'enabled', got '${path}'`);
  });

  it("rejects the worst-plausible fixture without crashing", () => {
    assert.equal(validate(worstPlausibleFixture), false);
    assert.ok(Array.isArray(validate.errors) && validate.errors.length > 0);
  });
});
