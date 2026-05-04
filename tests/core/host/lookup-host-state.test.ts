import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HOST_UNWRAP, lookupHostState } from "../../../src/core/host/host-api.js";

import type { HostAPI } from "../../../src/core/host/host-api.js";

function hostWithUnwrap(next?: HostAPI): HostAPI {
  return (next === undefined ? {} : { [HOST_UNWRAP]: next }) as HostAPI;
}

describe("lookupHostState", () => {
  it("returns undefined when called with an undefined host at runtime", () => {
    assert.equal(
      lookupHostState(undefined as unknown as HostAPI, () => "hit"),
      undefined,
    );
  });

  it("returns a value from the direct host before walking wrappers", () => {
    const direct = hostWithUnwrap();
    const result = lookupHostState(direct, (candidate) =>
      candidate === direct ? "hit" : undefined,
    );
    assert.equal(result, "hit");
  });

  it("walks the HOST_UNWRAP chain until the getter resolves", () => {
    const root = hostWithUnwrap();
    const wrapped = hostWithUnwrap(root);
    const result = lookupHostState(wrapped, (candidate) =>
      candidate === root ? { providerId: "openai" } : undefined,
    );
    assert.deepEqual(result, { providerId: "openai" });
  });

  it("returns undefined when nothing resolves anywhere in the unwrap chain", () => {
    const root = hostWithUnwrap();
    const wrapped = hostWithUnwrap(root);
    assert.equal(
      lookupHostState(wrapped, () => undefined),
      undefined,
    );
  });

  it("returns undefined for a direct host with no unwrap chain and no match", () => {
    assert.equal(
      lookupHostState(hostWithUnwrap(), () => undefined),
      undefined,
    );
  });

  it("returns the first match from the unwrap chain without walking deeper", () => {
    const root = hostWithUnwrap();
    const middle = hostWithUnwrap(root);
    const wrapped = hostWithUnwrap(middle);
    const result = lookupHostState(wrapped, (candidate) =>
      candidate === middle ? "middle" : undefined,
    );
    assert.equal(result, "middle");
  });

  it("stops on a self-referential unwrap chain instead of looping forever", () => {
    const selfWrapped = {} as HostAPI;
    Object.defineProperty(selfWrapped, HOST_UNWRAP, {
      value: selfWrapped,
      enumerable: true,
      configurable: true,
    });
    assert.equal(
      lookupHostState(selfWrapped, () => undefined),
      undefined,
    );
  });
});
