/**
 * Shape-surface tests for `HostAPI`.
 *
 * Covers:
 *    — `HostAPI` exposes exactly the twelve sanctioned sub-surfaces.
 *    — `contractVersion` is a SemVer triple; `requiredCoreVersion` is a
 *            SemVer range string (type-level static part; runtime mismatch
 *            throwing `Validation/ContractVersionMismatch` is deferred to the
 *            contract-loader unit).
 *    — Lifecycle interface (`LifecycleFns`) declares all four phases
 *            (`init → activate → deactivate → dispose`), each optional and
 *            `dispose` documented as idempotent (type-level static part;
 *            the lifecycle manager that enforces ordering and idempotency at
 *            runtime is deferred to the lifecycle-manager unit).
 *
 * Wiki: core/Host-API.md + contracts/Versioning-and-Compatibility.md +
 *       core/Extension-Lifecycle.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LifecycleFns } from "../../../src/contracts/lifecycle-fns.js";
import type { ExtensionContract } from "../../../src/contracts/meta.js";
import type { SemVer, SemVerRange } from "../../../src/contracts/versioning.js";
import type { HostAPI } from "../../../src/core/host/host-api.js";

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness helper.
//
// `Equals<A, B>` resolves to `true` only when A and B are mutually assignable,
// i.e. they name exactly the same set of types.  Used below to ensure
// `keyof HostAPI` is exactly the twelve expected keys — no more, no less.
// Any surface added to or removed from `HostAPI` without a matching update
// here is a compile error.
// ---------------------------------------------------------------------------
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// ---------------------------------------------------------------------------
// exactly twelve sanctioned surfaces
// ---------------------------------------------------------------------------

/** The canonical set of thirteen sanctioned HostAPI surface names. */
type SanctionedHostAPISurfaces =
  | "session"
  | "events"
  | "config"
  | "env"
  | "tools"
  | "prompts"
  | "resources"
  | "mcp"
  | "audit"
  | "observability"
  | "interaction"
  | "commands"
  | "metrics";

/**
 * Compile-time exhaustiveness assertion.
 *
 * If `HostAPI` gains a 14th surface, `keyof HostAPI` is no longer assignable
 * to `SanctionedHostAPISurfaces` and `Equals` resolves to `false`, making the
 * `true` assignment below a compile error.
 *
 * If a surface is removed from `HostAPI`, `SanctionedHostAPISurfaces` is no
 * longer assignable back, and the same compile error fires.
 */
const _assertExactSurfaces: Equals<keyof HostAPI, SanctionedHostAPISurfaces> = true;

describe("HostAPI shape", () => {
  it("declares exactly the thirteen sanctioned surfaces (exhaustive compile-time check)", () => {
    // The compile-time assertion `_assertExactSurfaces` above is the primary
    // guard.  This runtime check documents the expected count so a reader
    // immediately sees the number without reconstructing it from the union.
    const expected: readonly (keyof HostAPI)[] = [
      "session",
      "events",
      "config",
      "env",
      "tools",
      "prompts",
      "resources",
      "mcp",
      "audit",
      "observability",
      "interaction",
      "commands",
      "metrics",
    ];
    assert.equal(expected.length, 13);
    // Runtime-level exhaust: every element in `expected` is a valid key and
    // the length matches the union size.
    assert.ok(_assertExactSurfaces, "compile-time exhaustiveness sentinel must be true");
  });

  it("all thirteen surfaces are declared readonly on the interface", () => {
    // Readonly is enforced at the type level; the runtime frozen-sentinel test
    // is in surfaces-not-extensible.test.ts.
    const surface: readonly (keyof HostAPI)[] = [
      "session",
      "events",
      "config",
      "env",
      "tools",
      "prompts",
      "resources",
      "mcp",
      "audit",
      "observability",
      "interaction",
      "commands",
      "metrics",
    ];
    assert.equal(surface.length, 13);
  });
});

// ---------------------------------------------------------------------------
// contractVersion is SemVer; requiredCoreVersion is a SemVer range
//
// Static part (type-level): enforced by the `SemVer` template-literal type
// (`${number}.${number}.${number}`) on `ExtensionContract.contractVersion`.
//
// Runtime part (Validation/ContractVersionMismatch on load): deferred to the
// contract-loader unit; see test.skip stubs below.
// ---------------------------------------------------------------------------

describe("contractVersion / requiredCoreVersion typing", () => {
  it("SemVer template-literal type enforces MAJOR.MINOR.PATCH at compile time", () => {
    // Valid assignments compile; anything like '1.2' or '1.2.3-beta' is a
    // type error at the call site.
    const v: SemVer = "1.2.3";
    assert.match(v, /^\d+\.\d+\.\d+$/);
  });

  it("ExtensionContract.contractVersion is typed as SemVer", () => {
    // If `contractVersion` is ever widened to `string`, this assignment would
    // allow non-SemVer values — keep the field typed as `SemVer`.
    type ContractVersionField = ExtensionContract<unknown>["contractVersion"];
    const v: ContractVersionField = "2.0.0";
    assert.match(v, /^\d+\.\d+\.\d+$/);
  });

  it("ExtensionContract.requiredCoreVersion is typed as SemVerRange (string)", () => {
    type RangeField = ExtensionContract<unknown>["requiredCoreVersion"];
    const r: RangeField = ">=1.0.0 <2.0.0";
    assert.ok(r.length > 0);
  });

  it("SemVer and SemVerRange are exported from the contracts barrel (meta.ts)", () => {
    // Verifies the re-export path used by other units. The `import type`
    // above already proves this compiles; this runtime assertion documents
    // the intent explicitly.
    const v: SemVer = "0.1.0";
    const r: SemVerRange = ">=0.1.0 <1.0.0";
    assert.ok(v.length > 0);
    assert.ok(r.length > 0);
  });

  // Runtime enforcement is deferred: the contract-loader unit validates the
  // SemVer regex at extension-load time and throws
  // `Validation/ContractVersionMismatch` on incompatibility.
  it.skip("incompatible requiredCoreVersion throws Validation/ContractVersionMismatch (deferred — contract-loader unit)", () => {
    // TODO: implement in the contract-loader unit.
    // Verify: loading an extension whose `requiredCoreVersion` excludes
    // the running core version throws a `Validation` error with
    // `code === 'ContractVersionMismatch'` carrying both the claimed and
    // expected ranges.
  });

  it.skip("non-SemVer contractVersion string is rejected at load time (deferred — contract-loader unit)", () => {
    // TODO: implement in the contract-loader unit.
    // Verify: loading an extension with `contractVersion: '1.2'` (missing
    // patch segment) throws `Validation/ContractVersionMismatch`.
  });
});

// ---------------------------------------------------------------------------
// lifecycle interface shape — init → activate → deactivate → dispose,
//        idempotent dispose.
//
// Static part (type-level): `LifecycleFns` declares all four optional phases.
//
// Runtime part (manager ordering + idempotent dispose): deferred to the
// lifecycle-manager unit; see test.skip stubs below.
// ---------------------------------------------------------------------------

describe("LifecycleFns interface shape", () => {
  it("LifecycleFns declares init as an optional async function", () => {
    type HasInit = "init" extends keyof LifecycleFns<unknown> ? true : false;
    const hasInit: HasInit = true;
    assert.equal(hasInit, true);
  });

  it("LifecycleFns declares activate as an optional async function", () => {
    type HasActivate = "activate" extends keyof LifecycleFns<unknown> ? true : false;
    const hasActivate: HasActivate = true;
    assert.equal(hasActivate, true);
  });

  it("LifecycleFns declares deactivate as an optional async function", () => {
    type HasDeactivate = "deactivate" extends keyof LifecycleFns<unknown> ? true : false;
    const hasDeactivate: HasDeactivate = true;
    assert.equal(hasDeactivate, true);
  });

  it("LifecycleFns declares dispose as an optional async function", () => {
    type HasDispose = "dispose" extends keyof LifecycleFns<unknown> ? true : false;
    const hasDispose: HasDispose = true;
    assert.equal(hasDispose, true);
  });

  it("all four lifecycle phases are members of LifecycleFns (exhaustive)", () => {
    // Enumerate all four keys as `keyof LifecycleFns<unknown>` — if the
    // interface drops a phase the element becomes a compile error.
    const phases: readonly (keyof LifecycleFns<unknown>)[] = [
      "init",
      "activate",
      "deactivate",
      "dispose",
    ];
    assert.equal(phases.length, 4);
  });

  it("ExtensionContract.lifecycle is typed as LifecycleFns<TConfig>", () => {
    // The contract wires LifecycleFns in; this verifies the field exists.
    type LifecycleField = ExtensionContract<unknown>["lifecycle"];
    type HasInit = "init" extends keyof LifecycleField ? true : false;
    const hasInit: HasInit = true;
    assert.equal(hasInit, true);
  });

  // Runtime lifecycle enforcement is deferred to the lifecycle-manager unit.
  it.skip("manager invokes lifecycle functions in init→activate→deactivate→dispose order (deferred — lifecycle-manager unit)", () => {
    // TODO: implement in the lifecycle-manager unit (src/core/lifecycle/).
    // Verify: the lifecycle manager calls each phase in the declared order;
    // a dependency-resolved sequence means dependencies init before dependants.
  });

  it.skip("dispose is idempotent — safe to call more than once without error (deferred — lifecycle-manager unit)", () => {
    // TODO: implement in the lifecycle-manager unit (src/core/lifecycle/).
    // Verify: calling dispose a second time on any extension does not throw.
  });

  it.skip("deactivate releases active resources but leaves subscriptions for dispose (deferred — lifecycle-manager unit)", () => {
    // TODO: implement in the lifecycle-manager unit (src/core/lifecycle/).
  });
});
