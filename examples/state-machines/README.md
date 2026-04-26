# State Machines

State Machine extensions encode multi-stage workflows. The active SM (at
most one per session) governs stage progression: `allowedTools`,
`turnCap`, `grantStageTool`, parallel fan-out + join (Q-4 fail-fast).

Reference implementation in this directory:

| ID       | Use                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------- |
| `ralph/` | Six-stage case study: Discovery → Decompose → parallel(BuildA, BuildB) → JoinReview → Complete. |

Schema surface: see [`src/contracts/state-machines.ts`](../../src/contracts/state-machines.ts)
and [`src/contracts/stage-definitions.ts`](../../src/contracts/stage-definitions.ts).

Authoring a new SM: copy `ralph/` as the structural template. The case
study deliberately exercises every primitive (sequential, parallel,
join, allowedTools, grantStageTool, turnCap, completionSchema) so that
each can be removed or specialised.

Q-4 reminder: parallel fan-out is fail-fast. Any sibling failure aborts
the compound turn with `ExtensionHost/ParallelSiblingFailure` BEFORE the
join stage runs.
