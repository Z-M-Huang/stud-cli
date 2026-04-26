# UI

UI extensions ship one of two roles:

- **Subscriber** (many): observes the event bus and renders to a sink
  (terminal, file, IDE diagnostic, etc.). Does NOT raise prompts.
- **Interactor** (one active per session): owns the user-facing prompt
  surface (approvals, trust dialogs, confirm/yes-no).

The `activeCardinality: "one"` constraint applies to interactors; many
subscribers may run simultaneously.

Reference implementation in this directory:

| ID             | Role                    | Use                                        |
| -------------- | ----------------------- | ------------------------------------------ |
| `default-tui/` | interactor + subscriber | Default terminal UI shipped with stud-cli. |

Schema surface: see [`src/contracts/ui.ts`](../../src/contracts/ui.ts).

A new interactor must implement the Interaction Protocol's
`raise(request)` surface and obey the security model around prompt
serialisation. A new subscriber needs only to subscribe to events.
