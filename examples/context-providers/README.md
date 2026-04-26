# Context Providers

Context Provider extensions feed fragments into the LLM context-assembly
phase of the message loop. Some providers are pure (deterministic given
their config); others read from the environment and require user
confirmation via a declared capability.

Reference implementation in this directory:

| ID                    | Use                                               |
| --------------------- | ------------------------------------------------- |
| `system-prompt-file/` | Loads a system-prompt file from the project root. |

Schema surface: see [`src/contracts/context-providers.ts`](../../src/contracts/context-providers.ts).

Critical invariant (LLM context isolation): a Context Provider that
reaches outside the explicit user input must declare the capability and
obtain user confirmation. There is **no** bulk-read-env API. See
[`security/LLM-Context-Isolation.md`](../../../stud-cli.wiki/security/LLM-Context-Isolation.md).
