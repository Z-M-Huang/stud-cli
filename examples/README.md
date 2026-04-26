# Examples

This directory contains runnable reference examples for every stud-cli
extension category. Authors writing a new extension should copy from the
matching subdirectory as a starting point.

The examples-check CI script (`bun run scripts/examples-check.ts`) walks
`src/extensions/<category>/<id>/` and asserts a matching
`examples/<category>/<id>/` directory exists for every reference extension.

## The nine categories

| Category          | Folder                                     | Read first                           |
| ----------------- | ------------------------------------------ | ------------------------------------ |
| Providers         | [`providers/`](providers/)                 | `src/contracts/providers.ts`         |
| Tools             | [`tools/`](tools/)                         | `src/contracts/tools.ts`             |
| Hooks             | [`hooks/`](hooks/)                         | `src/contracts/hooks.ts`             |
| UI                | [`ui/`](ui/)                               | `src/contracts/ui.ts`                |
| Loggers           | [`loggers/`](loggers/)                     | `src/contracts/loggers.ts`           |
| State Machines    | [`state-machines/`](state-machines/)       | `src/contracts/state-machines.ts`    |
| Commands          | [`commands/`](commands/)                   | `src/contracts/commands.ts`          |
| Session Stores    | [`session-stores/`](session-stores/)       | `src/contracts/session-stores.ts`    |
| Context Providers | [`context-providers/`](context-providers/) | `src/contracts/context-providers.ts` |

## Per-example layout

Each `examples/<category>/<feature-id>/` directory is the on-disk shape of a
loadable extension config. At minimum it contains:

- `example.json` — a config that conforms to the category's `configSchema`.

Larger examples (e.g., reference extensions shipped under `bundled/` or
`reference/`) may include additional scaffolding such as a `README.md` or
a small fixture project the extension exercises.

## Scope

Examples are illustrative, not normative. The contract pages under
`src/contracts/` and the wiki at `../stud-cli.wiki/contracts/` are the
load-bearing specifications. If an example diverges from its contract,
the contract wins.
