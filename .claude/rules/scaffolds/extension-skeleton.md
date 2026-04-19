# Extension skeleton

A minimum, contract-conforming TypeScript template for a new extension. Adapt per category; the meta-shape is invariant.

> Wiki source: [`../../../../stud-cli.wiki/contracts/Contract-Pattern.md`](../../../../stud-cli.wiki/contracts/Contract-Pattern.md) and the specific category contract in [`../../../../stud-cli.wiki/contracts/`](../../../../stud-cli.wiki/contracts/).

---

## Layout

```
src/extensions/<category>/<extension-id>/
  contract.ts          # the typed contract object
  lifecycle.ts         # init / activate / deactivate / dispose
  config.schema.ts     # the configSchema, as a const JSONSchema
  index.ts             # exports the contract; no side effects on import
tests/extensions/<category>/<extension-id>/
  contract.test.ts     # shape, lifecycle, configSchema fixtures, security
```

## Template (`index.ts`)

```ts
import type { ExtensionContract } from "../../../../contracts/meta.js";

import { configSchema, type MyConfig } from "./config.schema.js";
import { deactivate, dispose, init } from "./lifecycle.js";

export const contract: ExtensionContract<MyConfig> = {
  kind: "<CategoryKind>",
  contractVersion: "1.0.0",
  requiredCoreVersion: ">=1.0.0 <2.0.0",
  lifecycle: { init, deactivate, dispose },
  configSchema,
  loadedCardinality: "unlimited",
  activeCardinality: "unlimited",
  stateSlot: null,
  validationSeverity: "optional",
  discoveryRules: { folder: "<category>", manifestKey: "<extensionId>" },
  reloadBehavior: "between-turns",
};
```

## Template (`config.schema.ts`)

```ts
export const configSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean", default: true },
  },
  required: ["enabled"],
} as const;

export interface MyConfig {
  readonly enabled: boolean;
}
```

## Template (`lifecycle.ts`)

```ts
import type { HostAPI } from "../../../../core/host-api.js";

import type { MyConfig } from "./config.schema.js";

let _host: HostAPI | null = null;

export async function init(host: HostAPI, _cfg: MyConfig): Promise<void> {
  _host = host;
  // Subscribe to host.events.on("...") here; keep the subscription handle on module state.
}

export async function deactivate(_host: HostAPI): Promise<void> {
  // Release any active resources — but leave subscriptions for dispose.
}

export async function dispose(_host: HostAPI): Promise<void> {
  // MUST be idempotent. Unsubscribe, release state, null out references.
  _host = null;
}
```

## Rules this skeleton encodes

- **ESM + NodeNext.** All relative imports use explicit `.js` extensions.
- **Type-only imports.** `import type { ... }` where nothing runs at runtime — `verbatimModuleSyntax` requires it.
- **No side effects on import.** `index.ts` exports the contract; nothing starts until `init` runs.
- **Dispose is idempotent.** Required by the meta-contract; make `dispose` safe to call twice.
- **Config is the only validated surface.** Do not validate runtime payloads in the contract.
- **One category per extension.** No multi-role hybrids.
- **No `throw new Error(...)`.** Use the typed error classes — see [`typed-errors.md`](typed-errors.md).

## Companion test

Every extension has a sibling test file that asserts the contract's shape. See [`test-shape.md`](test-shape.md) for the template.
