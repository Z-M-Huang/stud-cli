/**
 * Tests for src/core/context/isolation-audit.ts.
 *
 * The audit wrapper around `scanForLeaks`: when the verdict is clean it
 * returns the assembled request unchanged; when violations are present it
 * writes one audit record per violation and throws Validation/LLMContextLeak.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { enforceIsolation } from "../../../src/core/context/isolation-audit.js";
import { Validation } from "../../../src/core/errors/index.js";

import type { AssembledRequest } from "../../../src/core/context/assembler.js";
import type { IsolationInput } from "../../../src/core/context/isolation-guard.js";

function emptyAssembled(): AssembledRequest {
  return {
    systemPrompt: "",
    history: [],
    toolManifest: [],
    fragments: [],
    modelParams: {},
    tokenBreakdown: { systemPrompt: 0, history: 0, fragments: 0, toolManifest: 0, total: 0 },
  };
}

function makeInput(overrides: Partial<IsolationInput> = {}): {
  readonly input: IsolationInput;
  readonly writes: readonly Readonly<Record<string, unknown>>[];
} {
  const writes: Readonly<Record<string, unknown>>[] = [];
  const audit = {
    write(record: Readonly<Record<string, unknown>>): Promise<void> {
      writes.push(record);
      return Promise.resolve();
    },
  };
  const input: IsolationInput = {
    assembled: overrides.assembled ?? emptyAssembled(),
    secrets: overrides.secrets ?? { resolvedEnvValues: [], settingsLeafValues: [] },
    audit: overrides.audit ?? audit,
    userInput: overrides.userInput ?? [],
  };
  return { input, writes };
}

describe("enforceIsolation — clean path", () => {
  it("returns the assembled request unchanged when no leaks are detected", () => {
    const { input, writes } = makeInput();
    const result = enforceIsolation(input);
    assert.equal(result, input.assembled);
    assert.equal(writes.length, 0);
  });

  it("clean path writes nothing to the audit channel", () => {
    const { input, writes } = makeInput({
      assembled: { ...emptyAssembled(), systemPrompt: "no secrets here" },
      secrets: {
        resolvedEnvValues: [{ extId: "ext-a", name: "DB_PASSWORD", value: "s3cret" }],
        settingsLeafValues: [],
      },
    });
    const result = enforceIsolation(input);
    assert.equal(result.systemPrompt, "no secrets here");
    assert.equal(writes.length, 0);
  });
});

describe("enforceIsolation — violation path", () => {
  it("throws Validation/LLMContextLeak when a resolved env secret leaks into the system prompt", () => {
    const { input, writes } = makeInput({
      assembled: { ...emptyAssembled(), systemPrompt: "your key is s3cret" },
      secrets: {
        resolvedEnvValues: [{ extId: "ext-a", name: "API_KEY", value: "s3cret" }],
        settingsLeafValues: [],
      },
    });
    let caught: Validation | undefined;
    try {
      enforceIsolation(input);
    } catch (err) {
      caught = err as Validation;
    }
    assert.ok(caught instanceof Validation, "expected Validation thrown");
    assert.equal(caught.context["code"], "LLMContextLeak");
    const violations = caught.context["violations"] as readonly { source: string }[];
    assert.equal(Array.isArray(violations), true);
    assert.ok(violations.length > 0, "expected at least one violation");
    assert.equal(writes.length, violations.length);
  });

  it("emits one audit record per violation with class IsolationViolation", () => {
    const { input, writes } = makeInput({
      assembled: { ...emptyAssembled(), systemPrompt: "leak1 and leak2" },
      secrets: {
        resolvedEnvValues: [
          { extId: "ext-a", name: "K1", value: "leak1" },
          { extId: "ext-b", name: "K2", value: "leak2" },
        ],
        settingsLeafValues: [],
      },
    });
    assert.throws(() => enforceIsolation(input), Validation);
    assert.equal(writes.length, 2);
    for (const record of writes) {
      assert.equal(record["class"], "IsolationViolation");
      assert.ok("source" in record);
      assert.ok("identifier" in record);
      assert.ok("matchedOn" in record);
    }
  });

  it("settings leaf value leaking into system prompt also triggers violation", () => {
    const { input, writes } = makeInput({
      assembled: { ...emptyAssembled(), systemPrompt: "x supersecret y" },
      secrets: {
        resolvedEnvValues: [],
        settingsLeafValues: [{ path: "providers.openai.apiKey", value: "supersecret" }],
      },
    });
    assert.throws(() => enforceIsolation(input), Validation);
    assert.equal(writes.length, 1);
    assert.equal((writes[0] as { source: string }).source, "settings");
  });

  it("violation in a context fragment carries the fragmentOwnerExtId in the audit record", () => {
    const { input, writes } = makeInput({
      assembled: {
        ...emptyAssembled(),
        fragments: [
          {
            kind: "system-message",
            content: "config note containing s3cret",
            priority: 0,
            budget: 100,
            ownerExtId: "ext-leaky",
          },
        ],
      },
      secrets: {
        resolvedEnvValues: [{ extId: "ext-leaky", name: "K", value: "s3cret" }],
        settingsLeafValues: [],
      },
    });
    let caught: Validation | undefined;
    try {
      enforceIsolation(input);
    } catch (err) {
      caught = err as Validation;
    }
    assert.ok(caught instanceof Validation);
    assert.equal(writes.length, 1);
    assert.equal((writes[0] as { matchedOn: string }).matchedOn, "fragment");
    assert.equal((writes[0] as { fragmentOwnerExtId: string }).fragmentOwnerExtId, "ext-leaky");
  });

  it("violation in tool manifest content is detected", () => {
    const { input, writes } = makeInput({
      assembled: {
        ...emptyAssembled(),
        toolManifest: [{ id: "t1", name: "leaktool", schema: { secret: "s3cret" } }],
      },
      secrets: {
        resolvedEnvValues: [{ extId: "ext-x", name: "K", value: "s3cret" }],
        settingsLeafValues: [],
      },
    });
    assert.throws(() => enforceIsolation(input));
    assert.equal(writes.length, 1);
    assert.equal((writes[0] as { matchedOn: string }).matchedOn, "tools");
  });
});
