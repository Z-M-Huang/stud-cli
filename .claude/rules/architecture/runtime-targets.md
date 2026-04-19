# Runtime targets

**Node `>=22` is canonical.** Bun is a local-dev convenience. The two diverge on filesystem, process, network, and module-loading edges in ways that are easy to miss in a plugin host.

> Wiki source: none. This is a code-level policy specific to this repo; the wiki stays implementation-free.

---

## Directory policy

| Directory  | Runtime                          | Allowed imports                                                        |
| ---------- | -------------------------------- | ---------------------------------------------------------------------- |
| `src/`     | Node `>=22` only                 | `node:*`, project-relative, npm packages compatible with Node          |
| `tests/`   | Node (CI) + Bun (optional local) | `node:*`, `bun:test` / `bun:*` allowed **here only**, project-relative |
| `scripts/` | Bun (ergonomic)                  | `Bun.*`, `bun:*`, `node:*` all allowed                                 |
| `bin/`     | Node only (launcher)             | `node:*`, dynamic import of `dist/`                                    |
| `dist/`    | Node output of `tsc`             | (compiled; not edited)                                                 |

`src/` must not mention `Bun`, `Bun.*`, or import from `bun:*`. A future `scripts/ban-bun-globals.ts` should fail CI if this leaks.

## Module system

- `"type": "module"` at the package level. Source is ESM throughout.
- `tsconfig.base.json` sets `module: NodeNext` + `moduleResolution: NodeNext`. Do **not** switch to `bundler` resolution — it will let Node-incompatible resolution typecheck and ship.
- Relative imports include explicit extensions: `import { x } from "./foo.js"` (not `./foo`). TypeScript will typecheck `.js` imports against the sibling `.ts` source.
- `verbatimModuleSyntax: true` — `import`/`export` is preserved in the emit; mixing ESM and CJS syntax in a single file is a type error.

## Type surface

- `tsconfig.json` (for `src/`) sets `types: ["node"]`. No Bun types leak into application code.
- `tsconfig.test.json` sets `types: ["node", "bun"]` (via `@types/bun`). This is the only place Bun globals are visible to the type checker.

## Build and publish

- Build: `tsc -p tsconfig.json` → `dist/`.
- Publish: the `files` array ships `bin/`, `dist/`, `LICENSE`, `README.md`.
- `bin/stud-cli.js` is a committed, thin Node launcher — not a bundled artifact. It uses `#!/usr/bin/env node` and `import('../dist/cli/index.js')`.
- Do **not** introduce a bundler (`tsup`, `unbuild`, `tshy`, `esbuild`). Bundled output hides Node-incompatible edges that the `tsc` path catches. If a future need justifies bundling (e.g., startup speed for a single-file install), propose it explicitly.

## Testing

- `node --test --test-reporter=spec` is canonical and runs in CI against the **built** artifacts where possible, ensuring the semantics users ship with are what the tests verified.
- `bun test` is allowed locally for fast feedback. A failure that reproduces in `bun test` but not `node --test` (or vice versa) is a real bug — investigate, don't paper over.

## Why not Bun canonical

A plugin host touches:

- Filesystem: `fs` semantics (case sensitivity, symlink behavior, permission modes) differ between runtimes.
- Subprocess: `child_process` vs `Bun.spawn` have distinct argv/escape behavior.
- Network: `http` vs Bun's fetch backend implement TLS, keep-alive, and streaming differently.
- Module loading: ESM resolution rules differ at the edges (resolver hooks, conditional exports).

Users will run on Node. CI must ship Node semantics. If we ever flip the canonical runtime, it must be an explicit, documented change, not a gradual drift.

## Related wiki reading

- [`overview/Extensibility-Boundary.md`](../../../../stud-cli.wiki/overview/Extensibility-Boundary.md) — what runs in-process and why the surface is so small.
- [`security/Extension-Isolation.md`](../../../../stud-cli.wiki/security/Extension-Isolation.md) — v1 extensions share the Node process with core; no sandbox.
