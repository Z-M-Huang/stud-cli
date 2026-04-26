# Commands

Command extensions add slash-prefixed commands the user invokes through
the interactor. Commands receive a parsed `CommandArgs` payload and
return a `CommandResult` with both rendered text and a structured
payload.

Reference implementations in this directory (under `bundled/`):

| ID                        | Use                                                  |
| ------------------------- | ---------------------------------------------------- |
| `bundled/help/`           | `/help` — list known commands.                       |
| `bundled/save-and-close/` | `/save-and-close` — persist and exit.                |
| `bundled/trust/`          | `/trust` — manage project + MCP trust entries.       |
| `bundled/mode/`           | `/mode` — display current security mode (read-only). |
| `bundled/health/`         | `/health` — extension load + lifecycle status.       |
| `bundled/network-policy/` | `/network-policy` — manage outbound allowlist.       |

Schema surface: see [`src/contracts/commands.ts`](../../src/contracts/commands.ts).

Bundled vs. user commands: anything under `bundled/` ships with stud-cli
and is loaded at the bundled scope. User commands live under
`<global>/.stud/commands/` and are loaded at session start.
