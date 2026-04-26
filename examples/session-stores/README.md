# Session Stores

Session Store extensions persist the session manifest and per-extension
state slots. Exactly one Session Store is **active** per session; resume
must use the same store that wrote the session (cross-store resume is
`Session/ResumeMismatch`).

Reference implementation in this directory:

| ID            | Use                                                                |
| ------------- | ------------------------------------------------------------------ |
| `filesystem/` | Reference filesystem-backed store under `<projectRoot>/sessions/`. |

Schema surface: see [`src/contracts/session-stores.ts`](../../src/contracts/session-stores.ts).

Critical invariant: the manifest never stores resolved secrets — only
references (env-var names, keyring lookups). A loaded manifest must be
safe to share with a reviewer. See
[`core/Session-Manifest.md`](../../../stud-cli.wiki/core/Session-Manifest.md)
and [`security/Secrets-Handling.md`](../../../stud-cli.wiki/security/Secrets-Handling.md).
