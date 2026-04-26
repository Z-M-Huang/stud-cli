import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import { cliWrapperConfigSchema } from "../../../../src/extensions/providers/cli-wrapper/config.schema.js";
import { contract } from "../../../../src/extensions/providers/cli-wrapper/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { ProviderStreamEvent } from "../../../../src/contracts/providers.js";

function createAjvValidator() {
  const { $schema: _ignored, ...compilableSchema } = cliWrapperConfigSchema as Record<
    string,
    unknown
  >;
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(compilableSchema);
}

async function collectDeltas(
  stream: AsyncIterable<ProviderStreamEvent> | undefined,
): Promise<readonly ProviderStreamEvent[]> {
  assert.ok(stream !== undefined, "Expected provider stream to exist");
  const out: ProviderStreamEvent[] = [];
  for await (const event of stream) {
    out.push(event);
  }
  return out;
}

describe("cli-wrapper provider", () => {
  it("declares providers category", () => {
    assert.equal(contract.kind, "Provider");
  });

  it("accepts a valid config schema fixture", () => {
    const validate = createAjvValidator();
    assert.equal(
      validate({
        cliRef: { kind: "executable", path: "/usr/bin/echo" },
        argsTemplate: ["deterministic"],
        timeoutMs: 1000,
        seed: "abc",
      }),
      true,
    );
  });

  it("rejects a negative timeout in the config schema", () => {
    const validate = createAjvValidator();
    assert.equal(
      validate({
        cliRef: { kind: "executable", path: "/usr/bin/echo" },
        argsTemplate: [],
        timeoutMs: -1,
      }),
      false,
    );
  });

  it("produces deterministic output for identical input + seed", async () => {
    const { host } = mockHost({ extId: "cli-wrapper" });
    await contract.lifecycle.init?.(host, {
      cliRef: { kind: "executable", path: "/usr/bin/echo" },
      argsTemplate: ["deterministic", "{seed}", "{messages}"],
      seed: "abc",
    });

    const request = {
      messages: [{ role: "user" as const, content: "hi" }],
      tools: [],
      modelId: "reference-model",
    };

    const out1 = await collectDeltas(
      contract.surface.request(request, host, new AbortController().signal),
    );
    const out2 = await collectDeltas(
      contract.surface.request(request, host, new AbortController().signal),
    );

    assert.deepEqual(out1, out2);
  });

  it("throws ProviderTransient/NetworkTimeout on CLI timeout", async () => {
    const { host } = mockHost({ extId: "cli-wrapper" });
    await contract.lifecycle.init?.(host, {
      cliRef: { kind: "executable", path: "/usr/bin/sleep" },
      argsTemplate: ["60"],
      timeoutMs: 5,
    });

    await assert.rejects(
      collectDeltas(
        contract.surface.request(
          { messages: [], tools: [], modelId: "x" },
          host,
          new AbortController().signal,
        ),
      ),
      {
        class: "ProviderTransient",
        context: { code: "NetworkTimeout", timeoutMs: 5 },
      },
    );
  });

  it("Validation/ConfigSchemaViolation on non-executable path", async () => {
    const { host } = mockHost({ extId: "cli-wrapper" });

    await assert.rejects(
      () =>
        contract.lifecycle.init!(host, {
          cliRef: { kind: "executable", path: "/nonexistent-binary" },
          argsTemplate: [],
        }),
      {
        class: "Validation",
        context: { code: "ConfigSchemaViolation", field: "cliRef.path" },
      },
    );
  });

  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "cli-wrapper" });
    await contract.lifecycle.dispose?.(host);
    await contract.lifecycle.dispose?.(host);
  });
});
