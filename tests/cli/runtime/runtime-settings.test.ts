import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_CONTINUATION_MAX_ITERATIONS,
  resolveContinuationMaxIterations,
} from "../../../src/cli/runtime/runtime-settings.js";

import type { Settings } from "../../../src/cli/runtime/types.js";

describe("resolveContinuationMaxIterations", () => {
  it("returns the runtime default when the setting is absent", () => {
    assert.equal(resolveContinuationMaxIterations(undefined), DEFAULT_CONTINUATION_MAX_ITERATIONS);
    assert.equal(
      resolveContinuationMaxIterations({} as Settings),
      DEFAULT_CONTINUATION_MAX_ITERATIONS,
    );
    assert.equal(
      resolveContinuationMaxIterations({ runtime: {} } as Settings),
      DEFAULT_CONTINUATION_MAX_ITERATIONS,
    );
  });

  it("returns the configured runtime continuation budget when present", () => {
    assert.equal(
      resolveContinuationMaxIterations({
        runtime: { continuation: { maxIterations: 73 } },
      } as Settings),
      73,
    );
  });
});
