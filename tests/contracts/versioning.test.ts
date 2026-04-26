/**
 * Versioning primitive tests.
 *
 * `SemVer` is a template-literal type — invalid formats are caught at compile
 * time. These runtime tests confirm that well-formed values are accepted and
 * carry the expected string shape.
 *
 * `SemVerRange` is an unconstrained `string`; tests confirm it holds realistic
 * range expressions without truncation.
 *
 * Wiki: contracts/Versioning-and-Compatibility.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SemVer, SemVerRange } from "../../src/contracts/versioning.js";

describe("SemVer type", () => {
  it("accepts a standard triple-dot SemVer string", () => {
    const v: SemVer = "1.2.3";
    assert.equal(v, "1.2.3");
  });

  it("accepts 0.0.0 (zero version)", () => {
    const v: SemVer = "0.0.0";
    assert.equal(v, "0.0.0");
  });

  it("accepts a large version number", () => {
    const v: SemVer = "100.200.300";
    assert.match(v, /^\d+\.\d+\.\d+$/);
  });
});

describe("SemVerRange type", () => {
  it("accepts a standard >=X.Y.Z <A.B.C range", () => {
    const r: SemVerRange = ">=1.0.0 <2.0.0";
    assert.ok(r.length > 0);
  });

  it("accepts a caret range expression", () => {
    const r: SemVerRange = "^1.2.3";
    assert.ok(r.length > 0);
  });

  it("accepts an exact version as a range", () => {
    const r: SemVerRange = "1.0.0";
    assert.ok(r.length > 0);
  });
});
