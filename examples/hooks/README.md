# Hooks

Hook extensions intercept the message-loop stages. Each hook attaches to
exactly one of the 12 stage slots (six stages × pre/post) and implements
one of three sub-kinds: **guard**, **observer**, or **transform**.

Reference implementations in this directory:

| ID                   | Sub-kind  | Slot            | Use                                           |
| -------------------- | --------- | --------------- | --------------------------------------------- |
| `guard-example/`     | guard     | `pre-tool-call` | Refuses Bash commands starting with `rm -rf`. |
| `observer-example/`  | observer  | varies          | Records tool-call durations as audit events.  |
| `transform-example/` | transform | varies          | Strips emoji from rendered output.            |

Schema surface: see [`src/contracts/hooks.ts`](../../src/contracts/hooks.ts)
for the `HookContract<TConfig>` shape and the 12-slot taxonomy.

Slot rules: a guard refuses a stage with a typed error; an observer is
read-only; a transform rewrites the stage payload. See
[`contracts/Hooks.md`](../../../stud-cli.wiki/contracts/Hooks.md) on the wiki
for the precedence rules between sub-kinds attached to the same slot.
