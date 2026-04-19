# Typed errors

The error model is fixed at eight classes. No ad-hoc `throw new Error(string)` in `src/core/` or `src/contracts/` — the lint rule `no-restricted-syntax` enforces it.

> Wiki source: [`../../../../stud-cli.wiki/core/Error-Model.md`](../../../../stud-cli.wiki/core/Error-Model.md).

---

## The eight classes

```ts
export abstract class StudError extends Error {
  abstract readonly class: ErrorClass;
  abstract readonly code: string;
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export type ErrorClass =
  | "Validation"
  | "ProviderTransient"
  | "ProviderCapability"
  | "ToolTransient"
  | "ToolTerminal"
  | "Session"
  | "Cancellation"
  | "ExtensionHost";
```

| Class                | Example codes                                                      | Recoverable?                      |
| -------------------- | ------------------------------------------------------------------ | --------------------------------- |
| `Validation`         | `ShapeInvalid`, `ContractVersionMismatch`, `ConfigSchemaViolation` | No within this run.               |
| `ProviderTransient`  | `NetworkTimeout`, `Provider5xx`, `RateLimited`                     | Yes — retry per provider policy.  |
| `ProviderCapability` | `MissingStreaming`, `MissingToolCalling`, `ContextWindowTooSmall`  | No — user picks another provider. |
| `ToolTransient`      | `ExecutionTimeout`, `ResourceBusy`                                 | Sometimes — per tool policy.      |
| `ToolTerminal`       | `InputInvalid`, `OutputMalformed`, `Forbidden`, `NotFound`         | No — surface to the model.        |
| `Session`            | `ManifestDrift`, `StoreUnavailable`, `ResumeMismatch`              | Depends.                          |
| `Cancellation`       | `SessionCancelled`, `TurnCancelled`, `ToolCancelled`               | N/A — cooperative exit, audited.  |
| `ExtensionHost`      | `LifecycleFailure`, `DependencyCycle`, `DependencyMissing`         | No.                               |

## Throwing

```ts
import { ToolTerminal } from "../../errors/tool-terminal.js";

if (!result.ok) {
  throw new ToolTerminal("output did not match declared schema", undefined, {
    code: "OutputMalformed",
    toolId,
    schemaPath: result.path,
  });
}
```

Error code goes in `context.code` (or a dedicated field on the class) — not the message. Callers match on `class` and `code`, not on message substrings.

## Wrapping

Preserve the original class and code. The wrapper's message is **additive**:

```ts
try {
  await provider.request(req);
} catch (err) {
  throw new ProviderTransient(`provider ${providerId} request failed`, err, {
    code: err instanceof ProviderTransient ? err.context.code : "Unknown",
    providerId,
  });
}
```

`cause` is preserved so an operator can chase the original at audit time. Do **not** discard `err` — doing so erases context.

## Catching

Match on class and code, not message:

```ts
catch (err) {
  if (err instanceof ProviderTransient && err.context.code === "RateLimited") {
    await backoff(attempt);
    continue;
  }
  throw err;
}
```

## Empty catch is non-conformant

```ts
// NON-CONFORMANT
try {
  await x();
} catch {}

// If you genuinely need to suppress:
try {
  await x();
} catch (err) {
  host.events.emit("SuppressedError", {
    reason: "intentional — x() is a best-effort cache warm",
    cause: String(err),
  });
}
```

## User vs. model vs. audit surfaces

- **User UI.** Gets a message tuned for the user (from the Interaction Protocol or a typed render).
- **Model.** Gets the **typed error shape** — class, code, minimal context. Never a raw stack trace.
- **Audit trail.** Gets the full error: class, code, full context, cause chain, attempt count on retries.

An SM may explicitly opt into richer model-facing messages for a debugging workflow; default is "typed shape only."

## Partial-result tools

A tool that partially succeeds returns a partial payload **and** an `errors[]` field enumerating per-item typed errors. Do **not** blend errors into a success-shaped output — the LLM cannot recover from a silent half-failure.
