<p align="center">
  <img src="https://img.shields.io/badge/stud--cli-coding_CLI-3b82f6?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik00IDRoMTZ2NEg0ek00IDEwaDE2djRINHpNNCAxNmgxMHY0SDR6Ii8+PC9zdmc+" alt="stud-cli" />
</p>

<p align="center">
  <strong>A minimalist coding-assistant CLI built on Vercel's <code>ai-sdk</code>. Small core, nine extension categories, deterministic state-machine workflows.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/stud-cli"><img src="https://img.shields.io/npm/v/stud-cli?style=flat-square&color=cb3837&logo=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/stud-cli"><img src="https://img.shields.io/npm/dm/stud-cli?style=flat-square&color=cb3837&logo=npm" alt="npm downloads" /></a>
  <a href="https://github.com/Z-M-Huang/stud-cli"><img src="https://img.shields.io/github/stars/Z-M-Huang/stud-cli?style=flat-square&logo=github" alt="GitHub stars" /></a>
  <a href="https://github.com/Z-M-Huang/stud-cli/issues"><img src="https://img.shields.io/github/issues/Z-M-Huang/stud-cli?style=flat-square&logo=github" alt="GitHub issues" /></a>
  <a href="https://github.com/Z-M-Huang/stud-cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Z-M-Huang/stud-cli?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js >=22" />
  <img src="https://img.shields.io/badge/TypeScript-6.x-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 6.x" />
  <img src="https://img.shields.io/badge/built_on-ai--sdk-000000?style=flat-square" alt="Built on ai-sdk" />
  <img src="https://img.shields.io/badge/status-pre--release-orange?style=flat-square" alt="Status: Pre-release" />
  <img src="https://visitor-badge.laobi.icu/badge?page_id=Z-M-Huang.stud-cli&style=flat-square" alt="Visitors" />
</p>

<p align="center">
  <a href="#why-it-exists">Why</a> &nbsp;·&nbsp;
  <a href="#three-tenets">Three Tenets</a> &nbsp;·&nbsp;
  <a href="#status">Status</a> &nbsp;·&nbsp;
  <a href="#install">Install</a> &nbsp;·&nbsp;
  <a href="#usage">Usage</a> &nbsp;·&nbsp;
  <a href="#architecture">Architecture</a> &nbsp;·&nbsp;
  <a href="#contributing">Contributing</a> &nbsp;·&nbsp;
  <a href="#license">License</a>
</p>

---

## Why it exists

Most coding CLIs hard-wire one provider, one toolset, and one workflow — integration is a fork. And the LLM is treated as the author of the workflow, which means the workflow drifts whenever the model does.

**stud-cli** inverts both: the core is a tiny plugin host, and **[State Machines](https://github.com/Z-M-Huang/stud-cli/wiki/State-Machines)** are a first-class extension category with authority over turn progression. The LLM executes; code the user wrote holds authority.

## Three tenets

| Tenet                           | What it means                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Small core, many extensions** | Core owns the message loop, event bus, session format, context assembly, registries, env provider, host API, extension lifecycle, configuration scopes, security modes, MCP client, and discovery. Everything else is an extension. See [Extensibility Boundary](https://github.com/Z-M-Huang/stud-cli/wiki/Extensibility-Boundary). |
| **Deterministic over magical**  | State Machines govern turn progression. The LLM does not drive the workflow; the SM does. See [State Machines](https://github.com/Z-M-Huang/stud-cli/wiki/State-Machines) and the [State Machine Workflow flow](https://github.com/Z-M-Huang/stud-cli/wiki/State-Machine-Workflow).                                                  |
| **Trust is a real boundary**    | Entering a new project triggers a [first-run trust prompt](https://github.com/Z-M-Huang/stud-cli/wiki/Project-Trust). Environment and settings values do not enter the LLM request by default. See [LLM Context Isolation](https://github.com/Z-M-Huang/stud-cli/wiki/LLM-Context-Isolation).                                        |

## Status

`0.0.1` is still **pre-release**, but the CLI is no longer just a placeholder. The current source tree now includes a real bootstrap slice:

- `stud-cli` can run a first-run provider setup flow and write `~/.stud/settings.json`.
- entering a directory with `<cwd>/.stud/` now triggers a real project-trust decision before project settings are read.
- `stud-cli --version` and `stud-cli --help` work again.
- the bundled default console TUI owns the session header, resumed-history replay, assistant streaming, tool-call notices, and turn errors.
- sessions persist under `~/.stud/sessions/<sessionId>/manifest.json`, and `stud-cli --continue` resumes the latest session with prior conversation visible.
- `--headless` consumes stdin for a single turn; interaction prompts emit a structured headless-required error unless `--yolo` is set.
- the default runtime toolset is backed by `agentool` and includes all non-`task-*` tools (`bash`, `glob`, `grep`, `read`, `edit`, `write`, `multi-edit`, `diff`, `lsp`, `web-fetch`, `http-request`, `memory`, `sleep`, `web-search`, `tool-search`, and `ask-user`).

What is still incomplete:

- bundled-provider quality is uneven: `openai-compatible`, `gemini`, and `cli-wrapper` are the practical paths today; the Anthropic adapter is still incomplete.
- the full extension-discovery/runtime graph described in the wiki is not what the CLI boot path uses yet; bundled providers are statically registered for now.
- MCP, dynamic extension discovery/reload, SM runtime attach, and capability-negotiated provider/model switching are still integration gaps.

| Phase                                 | Scope                                                               | State         |
| ------------------------------------- | ------------------------------------------------------------------- | ------------- |
| Core types + error model              | Contract meta-shape, 9 contract interfaces, 8 typed error classes   | Planning      |
| Lifecycle + registries + message loop | Stage pipeline, per-category registries, validation                 | Planning      |
| Provider + Tools + UI (bundled)       | First-party provider, default toolset, default console TUI          | Runtime slice |
| Security + Session Store + audit      | Trust prompt, allowlist / ask / yolo, filesystem store, audit trail | Planning      |
| State Machines + MCP                  | Stage definitions, `grantStageTool`, MCP client                     | Planning      |
| `0.1.0` — first usable release        | Everything above + CI + packaging                                   | Not started   |

Track progress on [GitHub Issues](https://github.com/Z-M-Huang/stud-cli/issues) and the [wiki](https://github.com/Z-M-Huang/stud-cli/wiki).

## Install

```bash
npm install -g stud-cli
```

## Usage

```bash
stud-cli
stud-cli --help
stud-cli --version
```

On a fresh machine the CLI now prompts for:

1. a provider selection
2. a provider auth path
3. project trust when `<cwd>/.stud/` exists

The resulting global files live under `~/.stud/`:

- `settings.json` for provider selection and config
- `trust.json` for project trust decisions
- `secrets.json` for locally stored secret references used by non-env auth paths
- `audit.jsonl` for bootstrap-side audit records
- `sessions/<sessionId>/manifest.json` for durable session history

## Architecture

stud-cli is a plugin-host runtime with **nine extension categories**: Providers, Tools, Hooks, UI, Loggers, State Machines, Commands, Session Stores, and Context Providers. Each category is typed, versioned, and validated at load.

```mermaid
flowchart LR
    User[User]:::actor
    LLM[LLM backend]:::actor
    FS[(Filesystem)]:::actor
    MCPsrv[MCP server]:::actor

    subgraph Core[stud-cli core]
        direction TB
        Kernel[Message loop<br/>Host API<br/>Interaction protocol<br/>Session format<br/>Context assembly<br/>Registries<br/>Env provider<br/>Security modes<br/>MCP client<br/>Observability<br/>Discovery + validation]
    end

    subgraph Ext[Nine extension categories]
        direction TB
        Providers[Providers]
        Tools[Tools]
        Hooks[Hooks]
        UI[UI]
        Loggers[Loggers]
        SM[State Machines]
        Cmds[Commands]
        Stores[Session Stores]
        CtxP[Context Providers]
    end

    User -- "input / output" --- UI
    UI -- "events + interaction" --- Core
    Cmds -- "dispatch" --- Core
    Providers -- "adapter" --- Core
    Providers -- "requests" --- LLM
    Tools -- "tool calls" --- Core
    Hooks -- "stage interception" --- Core
    Loggers -- "sink" --- Core
    SM -- "authority" --- Core
    Stores -- "persistence" --- Core
    Stores -- "read / write" --- FS
    CtxP -- "context fragments" --- Core
    Core -- "MCP client" --- MCPsrv

    classDef actor fill:#eef,stroke:#447,color:#112
```

**Full architecture documentation lives in the [wiki](https://github.com/Z-M-Huang/stud-cli/wiki).** Start with whichever matches your intent:

- [High-Level Architecture](https://github.com/Z-M-Huang/stud-cli/wiki/High-Level-Architecture) — the one-page overview.
- [Contract Pattern](https://github.com/Z-M-Huang/stud-cli/wiki/Contract-Pattern) — the meta-shape every extension category conforms to.
- [Message Loop](https://github.com/Z-M-Huang/stud-cli/wiki/Message-Loop) — the six-stage turn lifecycle.
- [State Machines](https://github.com/Z-M-Huang/stud-cli/wiki/State-Machines) — the category that holds workflow authority.
- [Trust Model](https://github.com/Z-M-Huang/stud-cli/wiki/Trust-Model) — scopes, project trust, extension isolation posture.
- [Reading Paths](https://github.com/Z-M-Huang/stud-cli/wiki/Reading-Paths) — audience-based tours through the wiki.

## Contributing

The wiki is the architecture source of truth. Before opening a PR, read [`CLAUDE.md`](./CLAUDE.md) and the rules in [`.claude/rules/`](./.claude/rules/). Contract changes require a `contractVersion` bump on the matching wiki page — see [Versioning and Compatibility](https://github.com/Z-M-Huang/stud-cli/wiki/Versioning-and-Compatibility).

Open an issue first to discuss non-trivial changes: [GitHub Issues](https://github.com/Z-M-Huang/stud-cli/issues).

## License

[Apache-2.0](./LICENSE).

---

<p align="center">
  <sub>Built with Claude Code. Not affiliated with or endorsed by Anthropic.</sub>
</p>
