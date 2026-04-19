# Extensibility boundary

Core owns the turn lifecycle and the surfaces every extension talks to. Everything else is an extension category.

> Wiki source: [`../../../../stud-cli.wiki/overview/Extensibility-Boundary.md`](../../../../stud-cli.wiki/overview/Extensibility-Boundary.md).

---

## Rule of thumb

> **If an extension could replace it, it belongs under `src/extensions/<category>/` — not `src/core/`.**
> **If an extension must interoperate with it, it belongs in `src/core/` and is exposed only through the relevant contract.**

When in doubt, check the wiki page above. If the wiki is silent, open an `architecture-question` issue on the wiki — do not add a new core surface by stealth.

## What core owns (non-extensible)

- The message loop (stage boundaries, continuation bound).
- The event bus.
- The session manifest format and the session turn lifecycle.
- Context assembly (orchestration; Context Providers feed it).
- Registries (per-category).
- The env provider.
- The host API surface exposed to extensions.
- The extension lifecycle manager (`init → activate → deactivate → dispose`).
- Configuration scopes (bundled → global → project).
- Security modes (`ask` / `yolo` / `allowlist`) and the mode gate itself.
- The MCP client.
- Observability scaffolding (correlation IDs, audit writer).
- Extension discovery and the validation pipeline.

## What is extensible (the nine categories)

| Category          | Authority scope                                                                       |
| ----------------- | ------------------------------------------------------------------------------------- |
| Providers         | Wire-shape adapter to LLM backends (via `ai-sdk`).                                    |
| Tools             | Tool definitions + executors; typed error surface.                                    |
| Hooks             | Stage interception: transform / guard / observer.                                     |
| UI                | Subscribers (many) and interactor (one).                                              |
| Loggers           | Sinks for observability events.                                                       |
| State Machines    | Turn-progression authority; `allowedTools`, `turnCap`, `grantStageTool`.              |
| Commands          | Slash commands dispatched through the UI.                                             |
| Session Stores    | Persistence of the session manifest and extension state slots.                        |
| Context Providers | Fragments that feed context assembly (with user confirmation if capability-declared). |

## Before adding a file under `src/core/`

Ask, in order:

1. Could a future extension reasonably replace this behavior? If yes, it belongs in an extension category (possibly a new one — follow the [boundary change process](../../../../stud-cli.wiki/overview/Extensibility-Boundary.md#changing-the-boundary)).
2. Does this change the shape of a stage, a contract, or a host API surface? If yes, it **must** be reflected in the wiki first, then in code.
3. Does it introduce a new term? If yes, update [`overview/Glossary.md`](../../../../stud-cli.wiki/overview/Glossary.md) before writing code.

## Changing the boundary

Creating a new extension category is a wiki-first action. The wiki process is:

1. Open an issue proposing the category.
2. Write a draft per-category contract in `contracts/`.
3. Update `Extensibility-Boundary.md` and the sidebar.
4. Only then write code.

Do not ship a 10th category by stealth. The boundary is small on purpose.
