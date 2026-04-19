# CLAUDE.md — stud-cli operating manual

Rules for writing code in this repository. Applies to humans and LLM editors equally. Read before editing.

Companion docs:

- [`../stud-cli.wiki/`](../stud-cli.wiki/) — architecture source of truth (the spec).
- [`.claude/rules/`](.claude/rules/) — topic-scoped rules (scaffolds, invariants, anti-patterns) discoverable per the [Claude Code rules convention](https://code.claude.com/docs/en/claude-directory).

---

## 1. The wiki is the spec

The architecture lives in the peer wiki at [`../stud-cli.wiki/`](../stud-cli.wiki/). It documents **what** and **why**; this repository is the **how**.

- Read the relevant wiki page before proposing a design change.
- When the wiki and the code disagree, **the wiki wins**. Fix the code; do not edit the wiki to match.
- If the wiki is genuinely unclear or silent, open a wiki issue instead of inventing a rule in code (mirrors [wiki CLAUDE.md rule 8](../stud-cli.wiki/CLAUDE.md)).
- If a change to the code implies a change to the architecture, update the wiki first (`../stud-cli.wiki/CLAUDE.md`, Update Protocol).

Start points per task:

| Task                                             | Read first                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any change touching an extension contract        | [`contracts/Contract-Pattern.md`](../stud-cli.wiki/contracts/Contract-Pattern.md) and the category contract page                                      |
| Any change to the turn lifecycle                 | [`core/Message-Loop.md`](../stud-cli.wiki/core/Message-Loop.md)                                                                                       |
| Anything that proposes a new core surface        | [`overview/Extensibility-Boundary.md`](../stud-cli.wiki/overview/Extensibility-Boundary.md)                                                           |
| Any change touching trust, approvals, or secrets | [`security/Trust-Model.md`](../stud-cli.wiki/security/Trust-Model.md) and [`security/Tool-Approvals.md`](../stud-cli.wiki/security/Tool-Approvals.md) |

---

## 2. Safety-critical invariants (verbatim from the wiki)

These invariants are load-bearing for stud-cli's security story. They are restated here because code reviewers land in this file without the wiki in context. They come from [`../stud-cli.wiki/CLAUDE.md`](../stud-cli.wiki/CLAUDE.md) rule 2; if any of them drift, the wiki page is authoritative.

1. **SM precedence.** SM runs first on gated tool calls. SM-approve (via `allowedTools` or a matching `grantStageTool` token) runs in any mode, the mode gate is bypassed, and guard hooks still run. SM-deny (out-of-envelope with `grantStageTool` returning `deny`/`defer`, or headless auto-denied) blocks in any mode. No SM attached → the mode gate applies.
2. **LLM context isolation.** Environment variables and `settings.json` do not enter the LLM request except via explicit user input or a capability-declaring Context Provider with user confirmation. There is no bulk-read-env API.
3. **Mode is session-fixed.** There is no runtime security-mode switch.
4. **Single active Session Store per session.** Resume uses the same store that wrote the session.
5. **Project trust required on first entry to a new project.** No auto-load of untrusted `.stud/`.
6. **Session manifest never stores resolved secrets — only references.**
7. **Extension isolation: v1 is in-process, no sandbox.** Do not imply a sandbox exists in code, comments, or error messages.

Violating any of these is a critical bug. Any code PR that touches approval, config-load, session persistence, or context assembly must explicitly show why it does not.

---

## 3. Terminology lock

The glossary at [`../stud-cli.wiki/overview/Glossary.md`](../stud-cli.wiki/overview/Glossary.md) is authoritative. It is load-bearing because contract pages and error messages refer to these terms with precise meanings.

- **Never** use the hyphenated form of "built" + "in" in source code, identifiers, comments, error messages, log output, or docs. It is banned vocabulary per the wiki glossary.
- Use instead: `bundled`, `core`, `first-party`, `reference`, `default`, `immutable`, `attached`, `loaded`, `active`.
- If a new concept needs a name, update the wiki glossary first. Do not coin a term in code.

---

## 4. Contract change protocol

Every extension category has a typed, versioned contract. See [`contracts/Contract-Pattern.md`](../stud-cli.wiki/contracts/Contract-Pattern.md) for the meta-shape.

Any edit to a `*Contract` type in `src/contracts/` requires:

1. Bumping `contractVersion` on the matching wiki page per [`contracts/Versioning-and-Compatibility.md`](../stud-cli.wiki/contracts/Versioning-and-Compatibility.md).
2. Appending a changelog entry on that wiki page.
3. A PR description that enumerates which extensions break.

Breaking changes to the meta-shape itself (not a per-category field) are recorded on the affected category contracts' changelogs; the meta-shape page has no independent `contractVersion`.

---

## 5. Typed errors only

The error model is fixed at eight classes. See [`core/Error-Model.md`](../stud-cli.wiki/core/Error-Model.md).

| Class                | When to throw                                                 |
| -------------------- | ------------------------------------------------------------- |
| `Validation`         | Config/schema violation at load.                              |
| `ProviderTransient`  | Retryable provider failure (network, 5xx, rate-limited).      |
| `ProviderCapability` | Required provider feature absent.                             |
| `ToolTransient`      | Retryable tool failure (timeout, resource busy).              |
| `ToolTerminal`       | Non-retryable tool failure (schema violation, auth, logical). |
| `Session`            | Store/manifest/resume failure.                                |
| `Cancellation`       | Cooperative exit (not an error — audited).                    |
| `ExtensionHost`      | Lifecycle/dependency/cycle failure.                           |

Rules:

- No `throw new Error(string)` in `src/core/` or `src/contracts/`. The lint rule `no-restricted-syntax` enforces this.
- Wrapping an error preserves original class and code; the wrapper message is additive.
- Empty catch is non-conformant. An intentional swallow emits a `SuppressedError` observability event with a reason.
- Never expose internal details to the model by default. A tool returning `OutputMalformed` sends a typed error shape, not a stack trace.

---

## 6. Runtime target and module rules

- Canonical runtime for `src/` and CI tests: **Node `>=22`**. Bun is a local-dev convenience (install, script runner).
- Module system is **NodeNext**. Source is ESM (`"type": "module"`). Relative imports include explicit extensions (`./foo.js`, not `./foo`).
- No Bun globals (`Bun.*`, `bun:*` imports, `Bun.file`, `Bun.env`) outside `tests/` or `scripts/`. The Bun runtime is allowed to typecheck tests via `tsconfig.test.json` (which includes `@types/bun`); `tsconfig.json` intentionally does not.
- Publish output goes to `dist/` via `tsc`. `bin/stud-cli.js` is a thin launcher (`#!/usr/bin/env node` + dynamic `import('../dist/cli/index.js')`). Do not introduce a bundler.
- Rationale: a plugin host touches filesystem, process, network, and module-loading edges where Bun and Node diverge in ways that are easy to miss. CI tests ship the semantics users will actually run under.

---

## 7. Extensibility boundary

Before adding a file under `src/core/`, check [`../stud-cli.wiki/overview/Extensibility-Boundary.md`](../stud-cli.wiki/overview/Extensibility-Boundary.md).

Rule of thumb: **if an extension could replace it, it belongs under `src/extensions/<category>/` — not `src/core/`**. Core owns the message loop, event bus, session format, context assembly, registries, env provider, host API, extension lifecycle, configuration scopes, security modes, MCP client, and discovery. Everything else is an extension category.

Adding a new extension category requires following the wiki's [boundary change process](../stud-cli.wiki/overview/Extensibility-Boundary.md#changing-the-boundary). Do not create a new top-level kind in code without that.

---

## 8. Escalate ambiguity — do not invent unspecified architecture

If the wiki is silent or unclear on a case, you **must not** invent behavior in code. Options, in order of preference:

1. Pull the ambiguity into the PR description with a specific question.
2. Open a wiki issue and label it `architecture-question`.
3. Mark the code path with `throw new ExtensionHost({ code: "NotImplemented", note: "..." })` and link to the open question.

Do not add speculative features, hypothetical abstractions, or "future-proofing." This mirrors [wiki CLAUDE.md rule 6](../stud-cli.wiki/CLAUDE.md) ("surface ambiguity as a question — do not invent detail") and the repo's root discipline: _no over-engineering, no speculative features, no unrequested abstractions_.

---

## 9. Dependency controls (VCP)

Per [VCP dependency-management standard](https://raw.githubusercontent.com/Z-M-Huang/vcp/main/standards/core-dependency-management.md), every new dependency must clear all of the following **before** it is added:

1. **Existence verification.** The package is on the official npm registry (`bun info <pkg>`).
2. **Legitimacy signal.** Known publisher, non-trivial maintenance, plausible download count. No AI recommendation is sufficient on its own.
3. **Clean audit.** `bun audit --audit-level=high` is clean after the install.
4. **Exact version pin.** `package.json` uses the exact version, not a range. Caret pins are not accepted.
5. **`trustedDependencies` review.** If the package declares lifecycle scripts, its entry in `trustedDependencies` requires a PR comment explaining why the script is safe to run. The default answer is "leave untrusted and rely on the JS fallback, if one exists."
6. **Lockfile discipline.** `bun.lock` is committed. CI and `prepublishOnly` use `bun install --frozen-lockfile`. Lockfile diffs are reviewed.
7. **No trivial dependency.** A helper small enough to inline does not become a dependency.

Updates are deliberate: bump one package at a time, re-run the full verification chain, and review the transitive diff in `bun.lock`.

---

## Checklist for any non-trivial PR

- [ ] Wiki is already updated or the PR says why it does not need to be.
- [ ] All safety invariants in §2 hold after this change.
- [ ] No banned vocabulary (§3) or ranged-version pin introduced.
- [ ] No `throw new Error(string)` in `src/core/` or `src/contracts/`.
- [ ] Contract change bumps `contractVersion` (§4) if applicable.
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` is clean locally (lefthook will also gate pre-push).
