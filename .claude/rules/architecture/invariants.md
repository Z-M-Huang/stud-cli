# Safety-critical invariants

The seven invariants that must hold in every code change. Restated verbatim from the wiki because reviewers land here without the wiki in context.

> Wiki source: [`../../../../stud-cli.wiki/CLAUDE.md`](../../../../stud-cli.wiki/CLAUDE.md) rule 2.

If any of these drift from the wiki, the wiki is authoritative. Update this file; do not update the wiki to match code.

---

## 1. SM precedence on tool calls

SM runs first on gated tool calls.

- **SM-approve** (via the stage's `allowedTools` **or** a matching `grantStageTool` token) runs in any mode. The mode gate is bypassed. Guard hooks still run.
- **SM-deny** (out-of-envelope, and `grantStageTool` returned `deny`/`defer`, or headless auto-denied) blocks in any mode.
- **No SM attached** → the mode gate applies.

See [`security/Tool-Approvals.md`](../../../../stud-cli.wiki/security/Tool-Approvals.md) for the sequence diagram.

## 2. LLM context isolation

Environment variables and `settings.json` do **not** enter the LLM request.

The only paths that may reach the LLM are:

1. Explicit user input.
2. A Context Provider that declares the capability and obtained user confirmation.

There is **no** bulk-read-env API. A tool or provider asking for "all env vars" is a bug.

See [`security/LLM-Context-Isolation.md`](../../../../stud-cli.wiki/security/LLM-Context-Isolation.md).

## 3. Mode is session-fixed

The security mode (`ask`/`yolo`/`allowlist`) is set at session start and cannot change at runtime.

- No `setMode()` API.
- No flag that flips mode mid-turn.
- Resume uses the mode recorded on the session.

See [`security/Security-Modes.md`](../../../../stud-cli.wiki/security/Security-Modes.md).

## 4. Single active Session Store per session

Exactly one Session Store is active at a time. Resume uses the **same store** that wrote the session. Cross-store resume is a `Session.ResumeMismatch`.

See [`contracts/Session-Store.md`](../../../../stud-cli.wiki/contracts/Session-Store.md).

## 5. Project trust required on first entry

Entering a new project (`<cwd>/.stud/`) triggers a first-run trust prompt. The `.stud/` directory is **not** auto-loaded until the user confirms trust.

- Do not walk up the directory tree looking for a project root. The project root is exactly `<cwd>/.stud/`.
- Do not bypass the prompt with a flag.

See [`security/Project-Trust.md`](../../../../stud-cli.wiki/security/Project-Trust.md) and [`runtime/Project-Root.md`](../../../../stud-cli.wiki/runtime/Project-Root.md).

## 6. Session manifest never stores resolved secrets

The session manifest records **references** (e.g., env-var names, keyring lookups) — never the resolved value.

- No secret material in the manifest JSON.
- No secret material in audit events.
- A manifest loaded from disk must be safe to share with a reviewer.

See [`core/Session-Manifest.md`](../../../../stud-cli.wiki/core/Session-Manifest.md) and [`security/Secrets-Handling.md`](../../../../stud-cli.wiki/security/Secrets-Handling.md).

## 7. Extension isolation: v1 is in-process, no sandbox

v1 extensions run in the same process as core with no sandbox. Do **not**:

- Imply a sandbox exists in code, comments, error messages, or docs.
- Add a "safe mode" flag that claims to sandbox extensions.
- Skip an input check because "extensions can't reach X" — they can.

See [`security/Extension-Isolation.md`](../../../../stud-cli.wiki/security/Extension-Isolation.md).

---

## Verifying a PR against these

Any PR that touches approval, config loading, session persistence, context assembly, project entry, or extension loading must show explicitly why each relevant invariant still holds. "No regression" is not a sufficient answer — say _how_ each invariant is preserved.
