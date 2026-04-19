# Anti-patterns

A single list of "do not ship" smells specific to this repo. Each entry names a concrete smell and links to the invariant or pattern it violates.

> Wiki source: drawn from [`../../../stud-cli.wiki/CLAUDE.md`](../../../stud-cli.wiki/CLAUDE.md) Never list and associated invariant pages.

---

## Vocabulary

- **Banned hyphenated "built-in" form** in source, comments, identifiers, errors, logs, docs. Use `bundled`, `core`, `first-party`, `reference`, `default`, `immutable`, `attached`, `loaded`, or `active`. See [`../../CLAUDE.md`](../../CLAUDE.md) §3.
- **Silent vocabulary drift** (coining a term in code without updating [`overview/Glossary.md`](../../../stud-cli.wiki/overview/Glossary.md) first). Update the glossary on the wiki before using the term.

## Security boundary

- **Bulk-read-env API.** No "dump process.env into context" helper. See [`architecture/invariants.md`](architecture/invariants.md) §2.
- **Resolved secrets in the session manifest.** Store references; resolve at the point of use. See §6.
- **Claims of sandboxing.** v1 extensions run in-process. Do not imply a sandbox in code, comments, errors, logs, or docs. See §7.
- **Runtime mode switch.** No `setMode()`, no mid-turn mode flip, no "yolo once" flag. See §3.
- **Walk-up project-root resolution.** The project root is exactly `<cwd>/.stud/`. No ancestor scan. See §5.
- **Auto-load of untrusted `.stud/`.** First entry to a new project triggers a trust prompt; nothing in `.stud/` runs until trust is granted.

## Error model

- **`throw new Error("string")`** in `src/core/` or `src/contracts/`. Use one of the eight typed classes. See [`scaffolds/typed-errors.md`](scaffolds/typed-errors.md).
- **Empty catch.** `catch {}` hides bugs. If you must suppress, emit `SuppressedError` with a reason.
- **Error-message matching.** Callers match on class + code, never on message substrings.
- **Stack traces in model-facing errors.** The model gets the typed shape. Only audit sees the full chain.
- **Partial-result tools that return a success-shaped payload on partial failure.** Return the partial payload with an `errors[]` field carrying typed per-item errors.

## Contract hygiene

- **Reference or provider page redefining a contract field.** The contract page is normative; reference is illustrative. Fix the contract, not the reference.
- **Forgetting the `contractVersion` bump on a breaking change.** Breaking means breaking; bump it.
- **Multi-role extensions.** One category per extension. No hybrids.
- **Speaking two `contractVersion`s per extension load.** An extension picks one.
- **Reaching another extension's state slot.** Only `host.session.stateSlot(extId)` for its own `extId`.

## Runtime and modules

- **`Bun.*` or `bun:*` imports in `src/`.** Tests and scripts may use them; source may not. See [`architecture/runtime-targets.md`](architecture/runtime-targets.md).
- **Bundler escape hatches.** Do not introduce `tsup`, `unbuild`, `tshy`, or `esbuild`. Publish is `tsc` → `dist/` + thin launcher.
- **Implicit `.js` extensions on relative imports.** NodeNext requires explicit extensions. `./foo` is wrong; `./foo.js` is right (even when the file is `foo.ts`).
- **Mixing ESM and CJS syntax in a source file.** `verbatimModuleSyntax: true` will error.

## Dependency hygiene

- **Ranged version pins.** Direct devDeps and deps use exact versions. Caret and tilde are rejected.
- **Trivial dependencies.** A helper that fits in ten lines is not a dependency.
- **AI-recommended packages installed without human verification.** Existence, maintainer, audit, pin — all four gates must pass.
- **Installing without updating `bun.lock`.** Lockfile discipline is enforced by `--frozen-lockfile` in CI and `prepublishOnly`.
- **Silent `trustedDependencies` additions.** Each entry requires a comment in the PR.

## Testing

- **Mocks as the system under test.** A test that exercises only mocks proves only the mocks.
- **Snapshot tests on free-form prose.** Snapshot tests are for structured output; LLM prose snapshots rot immediately.
- **"Skip if flaky" tags.** Flake is a signal — debug it, do not mute it.
- **Tests that depend on wall-clock time without an injected clock.** Deterministic or it is not a test.

## Architecture drift

- **Adding a new top-level extension category without the wiki change process.** The boundary is small on purpose.
- **Adding to `src/core/` when an extension could replace the behavior.** Check [`architecture/extensibility-boundary.md`](architecture/extensibility-boundary.md) first.
- **Leaving a `TODO`/`FIXME` unlinked to an issue.** If it is important enough to write, it is important enough to file.
- **Adding a `CHANGELOG` / `CONTRIBUTING` / other top-level `.md` without a request.** Respect the wiki-as-spec principle.
