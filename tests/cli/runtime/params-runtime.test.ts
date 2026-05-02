/**
 * Tests for the per-leaf-path provenance-preserving runtime params store.
 *
 * Wiki: contracts/Provider-Params.md § "Merge layers — precedence";
 *       operations/Audit-Trail.md § "Audit records as redacted deltas".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSessionParamsStore,
  createParamsRuntimeStore,
} from "../../../src/cli/runtime/params-runtime.js";

describe("createParamsRuntimeStore", () => {
  it("returns empty store with no defaults", () => {
    const store = createParamsRuntimeStore({});
    assert.deepEqual(store.snapshot(), []);
    assert.deepEqual(store.asMergedBag(), {});
  });

  it("seeds defaultParams as 'defaultParams' source", () => {
    const store = createParamsRuntimeStore({
      defaultParams: { temperature: 0.7, thinkingConfig: { thinkingLevel: "high" } },
    });
    const snap = store.snapshot();
    assert.equal(snap.length, 2);
    assert.ok(snap.every((s) => s.sourceLayer === "defaultParams"));
  });

  it("set with sourceLayer='launch' overrides leaf and reports new provenance", () => {
    const store = createParamsRuntimeStore({
      defaultParams: { temperature: 0.7 },
    });
    store.set(["temperature"], 0.9, "launch");
    const entry = store.get(["temperature"]);
    assert.equal(entry?.value, 0.9);
    assert.equal(entry?.sourceLayer, "launch");
  });

  it("set with sourceLayer='/params' overrides 'launch' provenance", () => {
    const store = createParamsRuntimeStore({});
    store.set(["temperature"], 0.7, "launch");
    store.set(["temperature"], 0.5, "/params");
    assert.equal(store.get(["temperature"])?.sourceLayer, "/params");
  });

  it("preserves leaf-level provenance for nested paths", () => {
    const store = createParamsRuntimeStore({
      defaultParams: {
        thinkingConfig: { thinkingLevel: "high", thinkingBudget: 1024 },
      },
    });
    store.set(["thinkingConfig", "thinkingLevel"], "low", "/params");

    const level = store.get(["thinkingConfig", "thinkingLevel"]);
    assert.equal(level?.value, "low");
    assert.equal(level?.sourceLayer, "/params");

    const budget = store.get(["thinkingConfig", "thinkingBudget"]);
    assert.equal(budget?.value, 1024);
    assert.equal(budget?.sourceLayer, "defaultParams");
  });

  it("snapshot enumerates one entry per leaf", () => {
    const store = createParamsRuntimeStore({
      defaultParams: {
        temperature: 0.7,
        thinkingConfig: { thinkingLevel: "high", thinkingBudget: 1024 },
      },
    });
    store.set(["thinkingConfig", "thinkingLevel"], "low", "launch");

    const snap = store.snapshot();
    const keys = snap.map((s) => s.paramPath.join("."));
    assert.ok(keys.includes("temperature"));
    assert.ok(keys.includes("thinkingConfig.thinkingLevel"));
    assert.ok(keys.includes("thinkingConfig.thinkingBudget"));
  });

  it("asMergedBag reconstructs the nested tree without provenance", () => {
    const store = createParamsRuntimeStore({
      defaultParams: { thinkingConfig: { thinkingLevel: "high" } },
    });
    store.set(["thinkingConfig", "thinkingLevel"], "low", "/params");
    const bag = store.asMergedBag();
    assert.deepEqual(bag, { thinkingConfig: { thinkingLevel: "low" } });
  });
});

describe("createParamsRuntimeStore — defaults & swap projections", () => {
  it("applyDefaultParams replaces only the defaultParams layer", () => {
    const store = createParamsRuntimeStore({
      defaultParams: { temperature: 0.7, topP: 0.9 },
    });
    store.set(["topP"], 0.5, "launch");

    store.applyDefaultParams({ temperature: 0.5, topK: 50 });

    // launch override survived, defaultParams replaced
    assert.equal(store.get(["temperature"])?.value, 0.5);
    assert.equal(store.get(["temperature"])?.sourceLayer, "defaultParams");
    assert.equal(store.get(["topP"])?.value, 0.5);
    assert.equal(store.get(["topP"])?.sourceLayer, "launch");
    assert.equal(store.get(["topK"])?.value, 50);
    assert.equal(store.get(["topK"])?.sourceLayer, "defaultParams");
  });

  it("projectMergedBagWithDefaults previews swap without mutating", () => {
    const store = createParamsRuntimeStore({
      defaultParams: { temperature: 0.7 },
    });
    store.set(["topP"], 0.9, "/params");

    const projected = store.projectMergedBagWithDefaults({ temperature: 0.5, topK: 40 });

    // store untouched
    assert.equal(store.get(["temperature"])?.value, 0.7);
    // projection has next defaults + preserved /params override
    assert.deepEqual(projected, { temperature: 0.5, topK: 40, topP: 0.9 });
  });

  it("getEffective surfaces top-level value+source view", () => {
    const store = createParamsRuntimeStore({
      defaultParams: { temperature: 0.7 },
    });
    store.set(["topP"], 0.9, "launch");
    const eff = store.getEffective();
    assert.equal(eff["temperature"]?.value, 0.7);
    assert.equal(eff["temperature"]?.sourceLayer, "defaultParams");
    assert.equal(eff["topP"]?.value, 0.9);
    assert.equal(eff["topP"]?.sourceLayer, "launch");
  });

  it("sourceLayerAt returns undefined for unknown leaf", () => {
    const store = createParamsRuntimeStore({});
    assert.equal(store.sourceLayerAt(["mystery"]), undefined);
  });
});

describe("buildSessionParamsStore", () => {
  it("creates a store with defaults + launch overrides applied", () => {
    const store = buildSessionParamsStore({ temperature: 0.7 }, [
      { path: ["topP"], value: 0.9 },
      { path: ["thinkingConfig", "thinkingLevel"], value: "high" },
    ]);
    assert.equal(store.get(["temperature"])?.sourceLayer, "defaultParams");
    assert.equal(store.get(["topP"])?.sourceLayer, "launch");
    assert.equal(store.get(["thinkingConfig", "thinkingLevel"])?.sourceLayer, "launch");
  });

  it("works without defaults — launch-only entries still seeded", () => {
    const store = buildSessionParamsStore(undefined, [{ path: ["topP"], value: 0.9 }]);
    assert.equal(store.get(["topP"])?.value, 0.9);
    assert.equal(store.get(["topP"])?.sourceLayer, "launch");
  });

  it("returns a store with no entries when both are empty", () => {
    const store = buildSessionParamsStore(undefined, []);
    assert.deepEqual(store.snapshot(), []);
  });
});
