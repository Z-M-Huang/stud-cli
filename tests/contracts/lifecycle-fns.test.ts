/**
 * LifecycleFns shape tests.
 *
 * Asserts:
 *   1. Every lifecycle function is optional — an empty `{}` is a valid `LifecycleFns`.
 *   2. The four phases have the correct signatures at the type level.
 *   3. All four phases may coexist without conflict.
 *
 * The functions are not called in these tests (no real HostAPI is available
 * until Unit 4). Assertions operate on `typeof` values only.
 *
 * Wiki: contracts/Contract-Pattern.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LifecycleFns } from "../../src/contracts/lifecycle-fns.js";

describe("LifecycleFns shape", () => {
  it("allows omission of every lifecycle function (empty object is valid)", () => {
    const fns: LifecycleFns<{ readonly x: number }> = {};
    assert.equal(Object.keys(fns).length, 0);
  });

  it("accepts init with (host, cfg) signature", () => {
    const fns: LifecycleFns<{ readonly x: number }> = {
      init: async (_host, _cfg) => {
        /* no-op */
      },
    };
    assert.equal(typeof fns.init, "function");
  });

  it("accepts activate with (host) signature", () => {
    const fns: LifecycleFns<{ readonly x: number }> = {
      activate: async (_host) => {
        /* no-op */
      },
    };
    assert.equal(typeof fns.activate, "function");
  });

  it("accepts deactivate with (host) signature", () => {
    const fns: LifecycleFns<{ readonly x: number }> = {
      deactivate: async (_host) => {
        /* no-op */
      },
    };
    assert.equal(typeof fns.deactivate, "function");
  });

  it("accepts dispose with (host) signature", () => {
    const fns: LifecycleFns<{ readonly x: number }> = {
      dispose: async (_host) => {
        /* no-op */
      },
    };
    assert.equal(typeof fns.dispose, "function");
  });

  it("all four phases may coexist in one object", () => {
    const fns: LifecycleFns<{ readonly x: number }> = {
      init: async (_host, _cfg) => {
        /* no-op */
      },
      activate: async (_host) => {
        /* no-op */
      },
      deactivate: async (_host) => {
        /* no-op */
      },
      dispose: async (_host) => {
        /* no-op */
      },
    };
    assert.equal(typeof fns.init, "function");
    assert.equal(typeof fns.activate, "function");
    assert.equal(typeof fns.deactivate, "function");
    assert.equal(typeof fns.dispose, "function");
  });

  it("all phases are undefined when not provided", () => {
    const fns: LifecycleFns<{ readonly x: number }> = {};
    assert.equal(fns.init, undefined);
    assert.equal(fns.activate, undefined);
    assert.equal(fns.deactivate, undefined);
    assert.equal(fns.dispose, undefined);
  });
});
