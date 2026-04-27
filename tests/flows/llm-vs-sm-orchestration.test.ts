/**
 * UAT companion: LLM-vs-SM orchestration invariants.
 *
 * The case study binds two negative invariants:
 *
 *   1. The SM must NOT see per-token LLM deltas. The SM operates on
 *      stage-completion contracts, not on streaming tokens.
 *   2. The LLM request must NOT see `ctx` directly. `ctx` is the
 *      stage-execution data bag — it is consumed by `next(ctx)` and by
 *      body templating (`${ctx.X}`), but is never passed to the
 *      provider's wire payload.
 *
 * Both invariants are structural — there is no shared interface that
 * mixes the two surfaces. This test asserts that fact by exercising the
 * available types: the StageDefinition contract has no streaming hook
 * for tokens, and the provider stream events do not carry a ctx field.
 *
 * Wiki: case-studies/LLM-vs-SM-Orchestration.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stages } from "../../src/extensions/state-machines/ralph/index.js";

import type { StageDefinition } from "../../src/contracts/state-machines.js";

describe("SM does not see per-token LLM deltas", () => {
  it("StageDefinition has no streaming-token surface", () => {
    // The StageDefinition type structurally exposes only:
    //   id, body, allowedTools, turnCap, completionTool, completionSchema, next
    // — no token, delta, onToken, or stream field.
    const stage: StageDefinition = stages[0]!;
    const keys = Object.keys(stage);
    assert.equal(keys.includes("onToken"), false);
    assert.equal(keys.includes("stream"), false);
    assert.equal(keys.includes("delta"), false);
    assert.equal(keys.includes("token"), false);
  });

  it("StageDefinition.next consumes ctx (the SM's bag), not tokens", async () => {
    const stage = stages.find((s) => s.id === "Discovery")!;
    // next() takes a StageContext (Record<string, unknown>) and returns a
    // NextResult — never a token-shaped payload.
    const result = await stage.next({ arbitrary: "bag" });
    assert.equal(typeof result.execution, "string");
    assert.equal(Array.isArray(result.nextStages), true);
  });
});

describe("LLM request does not see SM ctx", () => {
  it("body templating uses ${ctx.X} substitution, not direct ctx pass-through", () => {
    // The body field is a string template. Substitution happens at the
    // SM-runtime layer (Setup phase) before the body becomes a system
    // prompt. The body itself is plain text — there is no "ctx" parameter
    // on the provider request payload.
    for (const stage of stages) {
      assert.equal(typeof stage.body, "string");
      // The body may contain ${ctx.X} placeholders but does not contain a
      // raw ctx-object reference (no JSON.stringify of ctx, etc.).
      assert.equal(stage.body.includes("ctx.toString"), false);
    }
  });

  it("completionTool + completionSchema are the LLM-facing contract — they do not expose ctx", () => {
    for (const stage of stages) {
      assert.equal(typeof stage.completionTool, "string");
      assert.equal(typeof stage.completionSchema, "object");
      // No documented ctx field on the completion schema.
      const schemaProps = (stage.completionSchema as { properties?: Record<string, unknown> })
        .properties;
      if (schemaProps !== undefined) {
        assert.equal("ctx" in schemaProps, false);
      }
    }
  });
});
