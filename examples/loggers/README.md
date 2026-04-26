# Loggers

Logger extensions are sinks for the observability event bus. They consume
audit + observation events and emit them to a durable surface (file,
syslog, OTLP, network endpoint, etc.).

Reference implementation in this directory:

| ID      | Use                                          |
| ------- | -------------------------------------------- |
| `file/` | NDJSON file logger with size-based rotation. |

Schema surface: see [`src/contracts/loggers.ts`](../../src/contracts/loggers.ts).

Loggers MUST NOT block the event bus — every emit is a fire-and-forget
async write. Logger failures are themselves observable but never
propagate as errors to the caller. See
[`core/Observability.md`](../../../stud-cli.wiki/core/Observability.md).
