import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Validation } from "../../../src/core/errors/validation.js";

interface IsolationAuditModule {
  readonly enforceIsolation: (input: unknown) => unknown;
}

interface IsolationGuardModule {
  readonly scanForLeaks: (input: unknown) => unknown;
}

interface AuditRecord {
  readonly class?: string;
  readonly [key: string]: unknown;
}

interface MockAuditWriter {
  readonly records: readonly AuditRecord[];
  write(record: AuditRecord): Promise<void>;
}

interface IsolationViolation {
  readonly source: "env" | "settings";
  readonly identifier: string;
  readonly fragmentOwnerExtId?: string;
  readonly matchedOn: "systemPrompt" | "history" | "tools" | "fragment";
}

interface IsolationVerdict {
  readonly clean: boolean;
  readonly violations: readonly IsolationViolation[];
}

interface AssembledRequestLike {
  readonly systemPrompt: string;
  readonly history: readonly { readonly role: string; readonly content: string }[];
  readonly toolManifest: readonly unknown[];
  readonly fragments: readonly {
    readonly kind: string;
    readonly content: string;
    readonly priority: number;
    readonly budget: number;
    readonly ownerExtId: string;
  }[];
  readonly modelParams: Readonly<Record<string, unknown>>;
  readonly tokenBreakdown: Readonly<Record<string, number>>;
}

interface IsolationInputLike {
  readonly assembled: AssembledRequestLike;
  readonly secrets: {
    readonly resolvedEnvValues: readonly {
      readonly extId: string;
      readonly name: string;
      readonly value: string;
    }[];
    readonly settingsLeafValues: readonly { readonly path: string; readonly value: string }[];
  };
  readonly audit: MockAuditWriter;
  readonly userInput: readonly string[];
}

const { enforceIsolation } = (await import(
  new URL("../../../src/core/context/isolation-audit.ts", import.meta.url).href
)) as IsolationAuditModule;
const { scanForLeaks } = (await import(
  new URL("../../../src/core/context/isolation-guard.ts", import.meta.url).href
)) as IsolationGuardModule;

function callScanForLeaks(input: IsolationInputLike): IsolationVerdict {
  return scanForLeaks(input) as IsolationVerdict;
}

function callEnforceIsolation(input: IsolationInputLike): AssembledRequestLike {
  return enforceIsolation(input) as AssembledRequestLike;
}

function isValidation(error: unknown): error is Validation {
  return typeof error === "object" && error !== null && "class" in error && "context" in error;
}

function runScan(input: IsolationInputLike): IsolationVerdict {
  return callScanForLeaks(input);
}

function expectClean(verdict: IsolationVerdict): void {
  assert.equal(verdict.clean, true);
  assert.equal(verdict.violations.length, 0);
}

function expectViolation(
  verdict: IsolationVerdict,
  expected: Partial<IsolationViolation> & { readonly matchedOn: IsolationViolation["matchedOn"] },
): void {
  assert.equal(verdict.clean, false);
  assert.equal(verdict.violations[0]?.matchedOn, expected.matchedOn);

  for (const [key, value] of Object.entries(expected)) {
    if (key === "matchedOn" || value === undefined) {
      continue;
    }
    assert.equal(verdict.violations[0]?.[key as keyof IsolationViolation], value);
  }
}

function scanCase(overrides: Partial<IsolationInputLike>): IsolationVerdict {
  return runScan({
    assembled: asReq(),
    secrets: { resolvedEnvValues: [], settingsLeafValues: [] },
    audit: mockAudit(),
    userInput: [],
    ...overrides,
  });
}

function mockAudit(): MockAuditWriter {
  const records: AuditRecord[] = [];
  return {
    get records(): readonly AuditRecord[] {
      return records;
    },
    write(record: AuditRecord): Promise<void> {
      records.push(record);
      return Promise.resolve();
    },
  };
}

const asReq = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    systemPrompt: "",
    history: [],
    toolManifest: [],
    fragments: [],
    modelParams: {},
    tokenBreakdown: { system: 0, history: 0, tools: 0, fragments: 0, total: 0 },
    ...over,
  }) as never;

describe("scanForLeaks", () => {
  it("clean when no secret appears", () => {
    expectClean(
      scanCase({
        assembled: asReq({ systemPrompt: "hi" }),
        secrets: {
          resolvedEnvValues: [{ extId: "e", name: "K", value: "sk-abc" }],
          settingsLeafValues: [],
        },
      }),
    );
  });

  it("detects env value in system prompt", () => {
    expectViolation(
      scanCase({
        assembled: asReq({ systemPrompt: "hello sk-abc world" }),
        secrets: {
          resolvedEnvValues: [{ extId: "e", name: "K", value: "sk-abc" }],
          settingsLeafValues: [],
        },
      }),
      { source: "env", identifier: "K", matchedOn: "systemPrompt" },
    );
  });

  it("detects env value in a fragment", () => {
    expectViolation(
      scanCase({
        assembled: asReq({
          fragments: [
            {
              kind: "system-message",
              content: "key sk-xyz",
              priority: 1,
              budget: 10,
              ownerExtId: "p",
            },
          ],
        }),
        secrets: {
          resolvedEnvValues: [{ extId: "e", name: "K", value: "sk-xyz" }],
          settingsLeafValues: [],
        },
      }),
      { matchedOn: "fragment", fragmentOwnerExtId: "p" },
    );
  });

  it("detects settings value in history", () => {
    expectViolation(
      scanCase({
        assembled: asReq({ history: [{ role: "user", content: "my-password" }] }),
        secrets: {
          resolvedEnvValues: [],
          settingsLeafValues: [{ path: "providers.x.apiKey", value: "my-password" }],
        },
      }),
      { source: "settings", identifier: "providers.x.apiKey", matchedOn: "history" },
    );
  });

  it("detects env value in tools", () => {
    expectViolation(
      scanCase({
        assembled: asReq({
          toolManifest: [{ id: "tool-1", name: "bash", schema: { token: "sk-tool" } }],
        }),
        secrets: {
          resolvedEnvValues: [{ extId: "e", name: "TOOL_KEY", value: "sk-tool" }],
          settingsLeafValues: [],
        },
      }),
      { identifier: "TOOL_KEY", matchedOn: "tools" },
    );
  });

  it("user input substring is allowed", () => {
    expectClean(
      scanCase({
        assembled: asReq({ systemPrompt: "sk-abc" }),
        secrets: {
          resolvedEnvValues: [{ extId: "e", name: "K", value: "sk-abc" }],
          settingsLeafValues: [],
        },
        userInput: ["sk-abc"],
      }),
    );
  });

  it("empty secret value is skipped", () => {
    expectClean(
      scanCase({
        assembled: asReq({ systemPrompt: "" }),
        secrets: {
          resolvedEnvValues: [{ extId: "e", name: "K", value: "" }],
          settingsLeafValues: [],
        },
      }),
    );
  });
});

describe("enforceIsolation", () => {
  it("clean returns assembled unchanged", () => {
    const request = asReq({ systemPrompt: "hi" });
    const audit = mockAudit();

    const out = callEnforceIsolation({
      assembled: request,
      secrets: { resolvedEnvValues: [], settingsLeafValues: [] },
      audit,
      userInput: [],
    });

    assert.equal(out, request);
    assert.equal(audit.records.length, 0);
  });

  it("not clean throws Validation/LLMContextLeak with full violation list", () => {
    const audit = mockAudit();

    assert.throws(
      () =>
        callEnforceIsolation({
          assembled: asReq({ systemPrompt: "sk-abc" }),
          secrets: {
            resolvedEnvValues: [{ extId: "e", name: "K", value: "sk-abc" }],
            settingsLeafValues: [],
          },
          audit,
          userInput: [],
        }),
      (error: unknown) => {
        assert.equal(isValidation(error), true);
        if (!isValidation(error)) {
          return false;
        }
        assert.equal(error.class, "Validation");
        assert.equal(error.context["code"], "LLMContextLeak");
        assert.equal(Array.isArray(error.context["violations"]), true);
        assert.match(error.message, /LLM context isolation/i);
        return true;
      },
    );

    assert.ok(audit.records.length > 0);
    assert.equal(audit.records[0]?.class, "IsolationViolation");
  });
});
