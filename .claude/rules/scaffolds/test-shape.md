# Test shape

Tests run under `node --test` in CI (canonical) and `bun test` optionally locally. Tests are TypeScript and are type-checked via `tsconfig.test.json`.

> Wiki source: tests themselves are not normative on the wiki; this is a code-level template aligned with the VCP testing standard.

---

## Template — contract conformance

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contract } from "../../../../src/extensions/<category>/<extension-id>/index.js";

describe("<extension-id> contract", () => {
  it("declares the correct category", () => {
    assert.equal(contract.kind, "<CategoryKind>");
  });

  it("declares a contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a requiredCoreVersion range", () => {
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("has an idempotent dispose", async () => {
    await contract.lifecycle.dispose?.(mockHost());
    await contract.lifecycle.dispose?.(mockHost());
  });

  it("has a parseable configSchema", () => {
    assert.equal(typeof contract.configSchema, "object");
    assert.equal((contract.configSchema as { type?: string }).type, "object");
  });
});
```

## Template — configSchema fixtures

Every contract asserts behavior against three fixture shapes:

```ts
import Ajv from "ajv";

import { configSchema } from "../../../../src/extensions/<category>/<extension-id>/config.schema.js";

const ajv = new Ajv({ strict: true });
const validate = ajv.compile(configSchema);

const valid = { enabled: true };
const invalid = { enabled: "not a boolean" };
const worstPlausible = {
  enabled: true,
  __proto__: { polluted: true },
  extra: "x".repeat(1_000_000),
};

describe("<extension-id> configSchema", () => {
  it("accepts valid config", () => {
    assert.equal(validate(valid), true);
  });
  it("rejects invalid config with a path", () => {
    assert.equal(validate(invalid), false);
    assert.match(validate.errors?.[0]?.instancePath ?? "", /\/enabled$/);
  });
  it("rejects worst-plausible input without crashing", () => {
    assert.equal(validate(worstPlausible), false);
  });
});
```

## Template — lifecycle order

```ts
it("runs lifecycle in order and disposes cleanly", async () => {
  const host = mockHost();
  const order: string[] = [];
  await contract.lifecycle.init?.(host, valid);
  order.push("init");
  await contract.lifecycle.activate?.(host);
  order.push("activate");
  await contract.lifecycle.deactivate?.(host);
  order.push("deactivate");
  await contract.lifecycle.dispose?.(host);
  order.push("dispose");
  assert.deepEqual(order, ["init", "activate", "deactivate", "dispose"]);
});
```

## Template — security boundary

For any extension that reads config from any scope:

```ts
it("never resolves a referenced secret into plaintext", async () => {
  const host = mockHost({ config: { apiKeyRef: { kind: "env", name: "MY_KEY" } } });
  await contract.lifecycle.init?.(host, valid);
  const slot = host.session.stateSlot("test-ext").get();
  assert.ok(JSON.stringify(slot).indexOf("secret-value") === -1);
});
```

## Rules

- **Assert on observable behavior, not implementation.** Tests that rely on private internals break on every refactor.
- **Never mock what you are testing.** A test that mocks the thing under test proves only the mock.
- **One assertion concept per `it` block.** Multiple asserts are fine when they describe one behavior; separate `it` blocks when they describe multiple.
- **Node's built-in runner, not a test framework.** Less surface area; better alignment with shipped runtime.

## Running

- Local, fast: `bun test`
- Local, canonical: `bun run test` → runs `node --test` against the TypeScript sources.
- CI: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run test`.

## Related wiki reading

- [`contracts/Validation-Pipeline.md`](../../../../stud-cli.wiki/contracts/Validation-Pipeline.md) — what load-time validation asserts; what the config-fixture tests double-check.
- [`contracts/Contract-Pattern.md`](../../../../stud-cli.wiki/contracts/Contract-Pattern.md) — the meta-shape fields a contract-conformance test walks.
