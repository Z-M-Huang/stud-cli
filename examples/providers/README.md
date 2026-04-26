# Providers

Provider extensions adapt LLM backends to the wire-shape stud-cli speaks.
Every provider ships a `configSchema` validating the per-instance config
plus a `protocol` declaring which adapter family it routes through.

Reference implementations in this directory:

| ID                   | Use                                                             |
| -------------------- | --------------------------------------------------------------- |
| `anthropic/`         | Anthropic Claude API.                                           |
| `openai-compatible/` | Any OpenAI-compatible endpoint (responses or chat-completions). |
| `gemini/`            | Google Gemini.                                                  |
| `cli-wrapper/`       | Deterministic test double that wraps a local CLI.               |

Schema surface: see [`src/contracts/providers.ts`](../../src/contracts/providers.ts)
for the `ProviderContract<TConfig>` shape.

To author a new provider, copy one of the directories above, rewrite the
config to match your backend, and implement the four-method
`ProtocolAdapter` interface.
