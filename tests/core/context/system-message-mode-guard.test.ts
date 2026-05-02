/**
 * `systemMessageMode: "remove"` cross-field guard tests.
 *
 * Wiki: contracts/Provider-Params.md, providers/OpenAI-Compatible.md (line 149),
 *       context/Context-Assembly.md (line 50).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertSystemMessageModeAllowed,
  isSystemLayerLoadBearing,
  type SystemLayerSegment,
} from "../../../src/core/context/system-message-mode-guard.js";
import { Validation } from "../../../src/core/errors/validation.js";

describe("isSystemLayerLoadBearing", () => {
  it("returns false for an empty layer", () => {
    assert.equal(isSystemLayerLoadBearing([]), false);
  });

  it("returns false for a static-system-prompt only layer", () => {
    const segments: readonly SystemLayerSegment[] = [
      { text: "you are a chat assistant", provenance: "static-system-prompt" },
    ];
    assert.equal(isSystemLayerLoadBearing(segments), false);
  });

  it("returns false when the SM stage body has empty text", () => {
    const segments: readonly SystemLayerSegment[] = [{ text: "", provenance: "sm-stage-body" }];
    assert.equal(isSystemLayerLoadBearing(segments), false);
  });

  it("returns true for a non-empty sm-stage-body segment", () => {
    const segments: readonly SystemLayerSegment[] = [
      { text: "act as a unit-test author", provenance: "sm-stage-body" },
    ];
    assert.equal(isSystemLayerLoadBearing(segments), true);
  });

  it("returns true for a non-empty system-message-provider segment", () => {
    const segments: readonly SystemLayerSegment[] = [
      { text: "context: respect repo conventions", provenance: "system-message-provider" },
    ];
    assert.equal(isSystemLayerLoadBearing(segments), true);
  });

  it("returns true when load-bearing segment is mixed with static", () => {
    const segments: readonly SystemLayerSegment[] = [
      { text: "static prompt", provenance: "static-system-prompt" },
      { text: "context provider says hi", provenance: "system-message-provider" },
    ];
    assert.equal(isSystemLayerLoadBearing(segments), true);
  });
});

describe("assertSystemMessageModeAllowed", () => {
  it("returns silently when mode is not 'remove'", () => {
    assert.doesNotThrow(() =>
      assertSystemMessageModeAllowed({
        params: { systemMessageMode: "developer" },
        systemLayer: [{ text: "load-bearing", provenance: "sm-stage-body" }],
        providerEntryId: "openai-prod",
        modelId: "gpt-5.1",
      }),
    );
  });

  it("returns silently when mode is unset", () => {
    assert.doesNotThrow(() =>
      assertSystemMessageModeAllowed({
        params: {},
        systemLayer: [{ text: "load-bearing", provenance: "sm-stage-body" }],
        providerEntryId: "openai-prod",
        modelId: "gpt-5.1",
      }),
    );
  });

  it("returns silently when system layer is empty even with mode=remove", () => {
    assert.doesNotThrow(() =>
      assertSystemMessageModeAllowed({
        params: { systemMessageMode: "remove" },
        systemLayer: [],
        providerEntryId: "openai-prod",
        modelId: "gpt-5.1",
      }),
    );
  });

  it("returns silently with static-only system layer + mode=remove", () => {
    assert.doesNotThrow(() =>
      assertSystemMessageModeAllowed({
        params: { systemMessageMode: "remove" },
        systemLayer: [{ text: "you are a chat assistant", provenance: "static-system-prompt" }],
        providerEntryId: "openai-prod",
        modelId: "gpt-5.1",
      }),
    );
  });

  it("throws Validation/SystemModeRemoveLoadBearing when system layer is load-bearing (sm-stage-body)", () => {
    let caught: unknown;
    try {
      assertSystemMessageModeAllowed({
        params: { systemMessageMode: "remove" },
        systemLayer: [{ text: "test author", provenance: "sm-stage-body" }],
        providerEntryId: "openai-prod",
        modelId: "gpt-5.1",
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Validation);
    assert.equal(caught.context["code"], "SystemModeRemoveLoadBearing");
    assert.equal(caught.context["providerEntryId"], "openai-prod");
    assert.equal(caught.context["modelId"], "gpt-5.1");
    assert.deepEqual(caught.context["loadBearingSegments"], ["sm-stage-body"]);
  });

  it("throws when system layer is load-bearing (system-message-provider)", () => {
    assert.throws(
      () =>
        assertSystemMessageModeAllowed({
          params: { systemMessageMode: "remove" },
          systemLayer: [{ text: "scratch", provenance: "system-message-provider" }],
          providerEntryId: "openai-prod",
          modelId: "gpt-5.1",
        }),
      Validation,
    );
  });
});
