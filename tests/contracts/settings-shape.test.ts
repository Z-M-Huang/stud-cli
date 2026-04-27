/**
 * Settings shape contract tests.
 *
 * Verifies:
 *   1. settingsSchema accepts a minimal valid settings object.
 *   2. Unknown top-level keys are rejected (additionalProperties: false).
 *   3. Unknown security mode values are rejected with a path to the field.
 *   4. allowlist accepts an array of strings.
 *   5. allowlist rejects non-array values with a path to the field.
 *   6. Worst-plausible input is rejected without crashing.
 *
 * Note: AJV v6 uses `dataPath` (dot-notation) not `instancePath` (slash-notation).
 * The `$schema` key is stripped before compiling because AJV v6 does not
 * recognise the JSON Schema 2020-12 meta-schema identifier.
 *
 * Wiki: contracts/Settings-Shape.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import { settingsSchema } from "../../src/contracts/settings-shape.js";

// ---------------------------------------------------------------------------
// AJV v6 setup — strip $schema before compiling
// ---------------------------------------------------------------------------

const { $schema: _ignored, ...compilableSchema } = settingsSchema as Record<string, unknown>;
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(compilableSchema);

// ---------------------------------------------------------------------------
// Helper: minimal valid settings
// ---------------------------------------------------------------------------

const minimalValid = {};

// ---------------------------------------------------------------------------
// Valid-input cases
// ---------------------------------------------------------------------------

describe("settingsSchema — valid inputs", () => {
  it("accepts a minimal valid settings object", () => {
    const result = validate(minimalValid);
    assert.equal(
      result,
      true,
      `Expected minimal valid settings to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("accepts an allowlist as an array of strings", () => {
    const result = validate({
      securityMode: { mode: "allowlist", allowlist: ["fs.read:*", "shell:safe-*"] },
    });
    assert.equal(
      result,
      true,
      `Expected allowlist array to be accepted; errors: ${JSON.stringify(validate.errors)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid-input cases
// ---------------------------------------------------------------------------

describe("settingsSchema — invalid inputs", () => {
  it("rejects an unknown top-level key with a path", () => {
    const result = validate({ ...minimalValid, bogusKey: true });
    assert.equal(result, false, "Expected unknown top-level key to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    assert.equal(
      firstError.keyword,
      "additionalProperties",
      `Expected 'additionalProperties' keyword, got '${firstError.keyword}'`,
    );
    assert.equal(
      (firstError.params as { additionalProperty?: string }).additionalProperty,
      "bogusKey",
      `Expected additionalProperty to be 'bogusKey'`,
    );
  });

  it("rejects an unknown security mode with a path", () => {
    const result = validate({
      securityMode: { mode: "wild" },
    });
    assert.equal(result, false, "Expected unknown security mode to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    const errorPath =
      (firstError as { instancePath?: string }).instancePath ??
      (firstError as { dataPath?: string }).dataPath ??
      "";
    assert.ok(
      errorPath.includes("securityMode") && errorPath.includes("mode"),
      `Expected rejection path to reference securityMode.mode, got '${errorPath}'`,
    );
  });

  it("rejects an allowlist that is not an array of strings with a path", () => {
    const result = validate({
      securityMode: { mode: "allowlist", allowlist: "not-an-array" },
    });
    assert.equal(result, false, "Expected non-array allowlist to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    const errorPath =
      (firstError as { instancePath?: string }).instancePath ??
      (firstError as { dataPath?: string }).dataPath ??
      "";
    assert.ok(
      errorPath.includes("allowlist"),
      `Expected rejection path to reference allowlist, got '${errorPath}'`,
    );
  });

  it("rejects worst-plausible input without crashing", () => {
    let result: boolean;
    try {
      result = validate({
        ...minimalValid,
        __proto__: { polluted: true },
        extra: "x".repeat(1_000_000),
      }) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible input to be rejected");
  });

  it("accepts active.provider and active.attachedSM when present", () => {
    const result = validate({
      active: {
        provider: "openai-compatible",
        attachedSM: "ralph",
      },
    });
    assert.equal(result, true);
  });
});
