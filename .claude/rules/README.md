# .claude/rules — index

Topic-scoped rules for working in this repo. Each rule file is a canonical scaffold, invariant, or anti-pattern pack that links back to the wiki page it derives from; if the wiki moves, we detect drift here.

Discovery follows the [Claude Code `.claude/rules/` convention](https://code.claude.com/docs/en/claude-directory): every `.md` under this tree is a rule. Rules without `paths:` frontmatter load at session start; rules with `paths:` load only when a matching file enters context. Subdirectories are discovered automatically.

Read [`../../CLAUDE.md`](../../CLAUDE.md) first. These rules assume the operating manual.

## When to read which

| You are about to…                                                   | Read first                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Touch any approval, trust, secret, or context-assembly path         | [architecture/invariants.md](architecture/invariants.md)                                                                                  |
| Add a stage or hook, or change anything in the turn lifecycle       | [architecture/message-loop.md](architecture/message-loop.md)                                                                              |
| Define or edit a contract, or write a new extension                 | [architecture/contract-shape.md](architecture/contract-shape.md), then [scaffolds/extension-skeleton.md](scaffolds/extension-skeleton.md) |
| Decide whether a new thing goes in `src/core/` or `src/extensions/` | [architecture/extensibility-boundary.md](architecture/extensibility-boundary.md)                                                          |
| Write code that reaches filesystem, subprocess, or network surfaces | [architecture/runtime-targets.md](architecture/runtime-targets.md)                                                                        |
| Throw, wrap, or catch an error                                      | [scaffolds/typed-errors.md](scaffolds/typed-errors.md)                                                                                    |
| Write a test                                                        | [scaffolds/test-shape.md](scaffolds/test-shape.md)                                                                                        |
| Review a PR for trap-setting patterns                               | [anti-patterns.md](anti-patterns.md)                                                                                                      |

## File list

- [architecture/invariants.md](architecture/invariants.md) — the seven safety invariants.
- [architecture/message-loop.md](architecture/message-loop.md) — six-stage turn lifecycle, ownership table.
- [architecture/contract-shape.md](architecture/contract-shape.md) — meta-shape for every extension contract, including config schema.
- [architecture/extensibility-boundary.md](architecture/extensibility-boundary.md) — what is core vs. extensible; rule of thumb.
- [architecture/runtime-targets.md](architecture/runtime-targets.md) — Node is canonical, Bun is local-dev only; allowed APIs per directory.
- [scaffolds/extension-skeleton.md](scaffolds/extension-skeleton.md) — TypeScript template for a new extension.
- [scaffolds/typed-errors.md](scaffolds/typed-errors.md) — the eight error classes with throw/wrap examples.
- [scaffolds/test-shape.md](scaffolds/test-shape.md) — `node --test` template covering shape, lifecycle, config, security.
- [anti-patterns.md](anti-patterns.md) — one list of "do not ship" smells.

## Drift detection

Each rule carries a `> Wiki source:` pointer. If the linked wiki page changes substantively, the rule needs review. A future script under `scripts/` can automate this check.

## Conditional loading (optional)

Rules currently load at session start (no `paths:` frontmatter). To scope a rule to a directory, add frontmatter:

```yaml
---
paths:
  - "src/contracts/**"
  - "src/extensions/**"
---
```

The rule then loads only when a matching file enters context. See [Claude Code `.claude/rules/` docs](https://code.claude.com/docs/en/claude-directory) for the full convention.
