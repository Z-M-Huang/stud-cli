/**
 * Cardinality and Activation contract tests (AC-23, AC-107, AC-112).
 *
 * Verifies:
 *   1. CATEGORY_CARDINALITY — per-category pin tests (SessionStore, StateMachine, UI, rest).
 *   2. assertCategoryCardinality — ok path and CardinalityMismatch path.
 *   3. cardinalityDeclarationSchema fixtures — valid / invalid / worst-plausible via AJV.
 *   4. contractVersion — aligns with wiki page (AC-107 / AC-112 drift discipline).
 *
 * Q-9 resolution:
 *   - UI.active = 'unlimited' (interactor/subscriber distinction in the roles array).
 *   - 'one-attached' retained exclusively for StateMachine.
 *   - SessionStore.active = 'one'.
 *
 * Wiki: contracts/Cardinality-and-Activation.md
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  CATEGORY_CARDINALITY,
  assertCategoryCardinality,
  cardinalityDeclarationSchema,
  contractVersion,
} from "../../src/contracts/cardinality-and-activation.js";

// ---------------------------------------------------------------------------
// 1. CATEGORY_CARDINALITY pin tests
// ---------------------------------------------------------------------------

describe("CATEGORY_CARDINALITY", () => {
  it("pins SessionStore.active = one", () => {
    assert.equal(CATEGORY_CARDINALITY.SessionStore.active, "one");
  });

  it("pins SessionStore.loaded = unlimited", () => {
    assert.equal(CATEGORY_CARDINALITY.SessionStore.loaded, "unlimited");
  });

  it("pins StateMachine.active = one-attached", () => {
    assert.equal(CATEGORY_CARDINALITY.StateMachine.active, "one-attached");
  });

  it("pins StateMachine.loaded = unlimited", () => {
    assert.equal(CATEGORY_CARDINALITY.StateMachine.loaded, "unlimited");
  });

  it("pins UI.active = unlimited per Q-9", () => {
    assert.equal(CATEGORY_CARDINALITY.UI.active, "unlimited");
  });

  it("pins UI.loaded = unlimited", () => {
    assert.equal(CATEGORY_CARDINALITY.UI.loaded, "unlimited");
  });

  it("pins every other category to unlimited on both axes", () => {
    const others = ["Provider", "Tool", "Hook", "Logger", "Command", "ContextProvider"] as const;
    for (const kind of others) {
      assert.equal(
        CATEGORY_CARDINALITY[kind].active,
        "unlimited",
        `${kind}.active should be 'unlimited'`,
      );
      assert.equal(
        CATEGORY_CARDINALITY[kind].loaded,
        "unlimited",
        `${kind}.loaded should be 'unlimited'`,
      );
    }
  });

  it("covers all nine CategoryKind values", () => {
    const keys = Object.keys(CATEGORY_CARDINALITY);
    assert.equal(keys.length, 9);
  });

  it("is frozen (top-level)", () => {
    assert.ok(Object.isFrozen(CATEGORY_CARDINALITY));
  });
});

// ---------------------------------------------------------------------------
// 2. assertCategoryCardinality
// ---------------------------------------------------------------------------

describe("assertCategoryCardinality", () => {
  it("returns ok:true for a matching StateMachine declaration", () => {
    const result = assertCategoryCardinality("StateMachine", {
      loaded: "unlimited",
      active: "one-attached",
    });
    assert.equal(result.ok, true);
  });

  it("returns ok:true for a matching SessionStore declaration", () => {
    const result = assertCategoryCardinality("SessionStore", {
      loaded: "unlimited",
      active: "one",
    });
    assert.equal(result.ok, true);
  });

  it("returns ok:true for a matching Provider declaration", () => {
    const result = assertCategoryCardinality("Provider", {
      loaded: "unlimited",
      active: "unlimited",
    });
    assert.equal(result.ok, true);
  });

  it("returns ok:false with CardinalityMismatch for UI declared as active:one (wrong per Q-9)", () => {
    const result = assertCategoryCardinality("UI", { loaded: "unlimited", active: "one" });
    assert.equal(result.ok, false);
    if (result.ok) return assert.fail("expected ok:false");
    assert.equal(result.error.code, "CardinalityMismatch");
  });

  it("error.class is 'Validation' on mismatch", () => {
    const result = assertCategoryCardinality("SessionStore", {
      loaded: "unlimited",
      active: "unlimited",
    });
    assert.equal(result.ok, false);
    if (result.ok) return assert.fail("expected ok:false");
    assert.equal(result.error.class, "Validation");
  });

  it("error.expected reflects the canonical map entry on mismatch", () => {
    const result = assertCategoryCardinality("StateMachine", {
      loaded: "unlimited",
      active: "one",
    });
    assert.equal(result.ok, false);
    if (result.ok) return assert.fail("expected ok:false");
    assert.equal(result.error.expected.active, "one-attached");
    assert.equal(result.error.expected.loaded, "unlimited");
  });

  it("error.actual reflects the declared values on mismatch", () => {
    const result = assertCategoryCardinality("StateMachine", {
      loaded: "unlimited",
      active: "one",
    });
    assert.equal(result.ok, false);
    if (result.ok) return assert.fail("expected ok:false");
    assert.equal(result.error.actual.active, "one");
    assert.equal(result.error.actual.loaded, "unlimited");
  });
});

// ---------------------------------------------------------------------------
// 3. cardinalityDeclarationSchema fixtures
// ---------------------------------------------------------------------------

describe("cardinalityDeclarationSchema", () => {
  // AJV v6 does not support the 2020-12 $schema URI; strip before compiling.
  const { $schema: _ignored, ...compilableSchema } = cardinalityDeclarationSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid declaration", () => {
    const result = validate({ loaded: "unlimited", active: "one-attached" });
    assert.equal(
      result,
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("accepts unlimited/unlimited (most categories)", () => {
    const result = validate({ loaded: "unlimited", active: "unlimited" });
    assert.equal(
      result,
      true,
      `Expected unlimited/unlimited to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("accepts unlimited/one (SessionStore)", () => {
    const result = validate({ loaded: "unlimited", active: "one" });
    assert.equal(
      result,
      true,
      `Expected unlimited/one to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects an unknown active value and reports the error at /active", () => {
    const result = validate({ loaded: "unlimited", active: "bogus" });
    assert.equal(result, false, "Expected unknown active value to be rejected");
    const errors = validate.errors ?? [];
    const activeError = errors.find(
      (e) =>
        (e as { dataPath?: string }).dataPath?.includes("active") === true ||
        (e as { instancePath?: string }).instancePath?.includes("active") === true ||
        String(e.schemaPath ?? "").includes("active"),
    );
    assert.ok(
      activeError != null,
      `Expected an error referencing 'active'; got ${JSON.stringify(errors)}`,
    );
  });

  it("accepts 'n' as a valid loaded value (string tag form)", () => {
    // LoadedCardinality is the simple string union "unlimited" | "n" | "one".
    // The object form { kind: "n"; n: number } is a separate type in cardinality.ts.
    // Per the interface contract, "n" as a plain string is a valid loaded value.
    const result = validate({ loaded: "n", active: "unlimited" });
    assert.equal(
      result,
      true,
      `Expected { loaded: "n", active: "unlimited" } to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects an unknown loaded value", () => {
    const result = validate({ loaded: "bogus", active: "unlimited" });
    assert.equal(result, false, "Expected unknown loaded value to be rejected");
  });

  it("rejects missing required 'loaded' field", () => {
    const result = validate({ active: "unlimited" });
    assert.equal(result, false, "Expected missing loaded to be rejected");
  });

  it("rejects missing required 'active' field", () => {
    const result = validate({ loaded: "unlimited" });
    assert.equal(result, false, "Expected missing active to be rejected");
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let rejected: boolean;
    try {
      rejected = !validate({
        loaded: "unlimited",
        active: "one",
        __proto__: { polluted: true },
        extra: "x".repeat(1_000_000),
      });
    } catch (err) {
      return assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.ok(rejected, "Expected worst-plausible fixture to be rejected");
  });
});

// ---------------------------------------------------------------------------
// 4. contractVersion drift discipline (AC-107 / AC-112)
//
// AC-107: every edit to a *Contract type in src/contracts/ must bump contractVersion
//   on the wiki page and append a changelog entry in the same PR.
// AC-112: scripts/wiki-drift.ts compares contractVersion in src/contracts/*.ts against
//   ../stud-cli.wiki/contracts/*.md and exits non-zero on mismatch. For per-category
//   contracts that embed contractVersion as an object property literal the drift script
//   auto-detects mismatches. This meta-contract (cardinality-and-activation.ts) exports
//   contractVersion as a standalone named const; the 'matches wiki page' test below acts
//   as the explicit drift guard for this module. The full end-to-end drift-detection
//   behaviour is covered in tests/scripts/wiki-drift.test.ts.
// ---------------------------------------------------------------------------

describe("contractVersion (AC-107 / AC-112)", () => {
  it("exports a semver-shaped contractVersion string", () => {
    assert.match(
      contractVersion,
      /^\d+\.\d+\.\d+$/,
      "contractVersion must be a SemVer string (X.Y.Z)",
    );
  });

  it("matches the contractVersion declared in the wiki page", async () => {
    // Derive the wiki path relative to the project root (process.cwd() is
    // stud-cli/ when tests run via 'node --test' or 'bun test').
    const wikiPath = join(
      process.cwd(),
      "../stud-cli.wiki/contracts/Cardinality-and-Activation.md",
    );

    let wikiContent: string;
    try {
      wikiContent = await readFile(wikiPath, "utf8");
    } catch {
      // Wiki directory not present in this checkout — skip the file-read assertion.
      // The wiki-drift CI job (scripts/wiki-drift.ts) catches divergence in CI
      // where the wiki peer repo is always present.
      return;
    }

    // Match the wiki format: `contractVersion`: **1.0.0**
    // Handles variants: backtick or bold wrapping around the keyword and/or value.
    // The same pattern is used by extractMdContractVersion() in scripts/wiki-drift.ts.
    const match = /`?\*{0,2}contractVersion\*{0,2}`?:[ \t]*\*{0,2}(\d+\.\d+\.\d+)\*{0,2}/i.exec(
      wikiContent,
    );
    assert.ok(
      match !== null,
      `Wiki page at ${wikiPath} must declare a contractVersion. ` +
        "Add a line like: `contractVersion`: **X.Y.Z** per contracts/Versioning-and-Compatibility.md.",
    );

    const wikiVersion = match[1];
    assert.equal(
      contractVersion,
      wikiVersion,
      `Exported contractVersion "${contractVersion}" must match wiki page ` +
        `contractVersion "${String(wikiVersion)}". ` +
        "Bump both in the same PR per AC-107; the wiki-drift CI check " +
        "(bun run scripts/wiki-drift.ts) will also catch this divergence.",
    );
  });

  it("wiki-drift script exists and is runnable", async () => {
    // AC-112: the drift-detection script must exist at scripts/wiki-drift.ts.
    // Its functional behaviour (drift detected / clean) is tested with fixture
    // directories in tests/scripts/wiki-drift.test.ts.
    const scriptPath = join(process.cwd(), "scripts/wiki-drift.ts");
    const scriptSource = await readFile(scriptPath, "utf8");
    assert.ok(
      scriptSource.includes("runWikiDrift"),
      "scripts/wiki-drift.ts must export runWikiDrift() for testability",
    );
    assert.ok(
      scriptSource.includes("contractVersion"),
      "scripts/wiki-drift.ts must reference contractVersion to perform drift checks",
    );
  });
});
