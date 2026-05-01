import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createActiveSelectionHolder } from "../../../src/cli/runtime/active-selection.js";

import type { ProviderSelection } from "../../../src/cli/runtime/types.js";

function makeSelection(entryId: string, modelId: string): ProviderSelection {
  return {
    entryId,
    protocolId: "openai-compatible",
    modelId,
    config: {
      protocol: "openai-compatible",
      apiKeyRef: { kind: "env", name: "X" },
      baseURL: "https://x",
      models: [modelId],
    },
  };
}

describe("ActiveSelectionHolder", () => {
  it("starts at revision 0 and exposes the initial selection", () => {
    const initial = makeSelection("bailian", "qwen");
    const holder = createActiveSelectionHolder(initial);
    assert.equal(holder.revisionId(), 0);
    assert.deepEqual(holder.current(), initial);
  });

  it("bumps revisionId by exactly one on swap", () => {
    const holder = createActiveSelectionHolder(makeSelection("bailian", "qwen"));
    holder.swap(makeSelection("bailian", "glm"));
    assert.equal(holder.revisionId(), 1);
    holder.swap(makeSelection("openai-prod", "gpt-4o"));
    assert.equal(holder.revisionId(), 2);
  });

  it("notifies onChange subscribers on each swap", () => {
    const holder = createActiveSelectionHolder(makeSelection("bailian", "qwen"));
    const observed: string[] = [];
    const unsubscribe = holder.onChange((sel) => observed.push(`${sel.entryId}/${sel.modelId}`));
    holder.swap(makeSelection("bailian", "glm"));
    holder.swap(makeSelection("openai-prod", "gpt-4o"));
    assert.deepEqual(observed, ["bailian/glm", "openai-prod/gpt-4o"]);
    unsubscribe();
    holder.swap(makeSelection("bailian", "qwen"));
    assert.equal(observed.length, 2);
  });

  it("current() reflects the most recent swap", () => {
    const holder = createActiveSelectionHolder(makeSelection("bailian", "qwen"));
    const next = makeSelection("openai-prod", "gpt-4o");
    holder.swap(next);
    assert.deepEqual(holder.current(), next);
  });
});
