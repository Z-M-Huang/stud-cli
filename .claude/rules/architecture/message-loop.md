# Message loop

Every turn walks the same six stages in the same order. Core owns stage boundaries; extensions attach only through hook points.

> Wiki source: [`../../../../stud-cli.wiki/core/Message-Loop.md`](../../../../stud-cli.wiki/core/Message-Loop.md).

---

## The six stages

```
RECEIVE_INPUT  → COMPOSE_REQUEST  → SEND_REQUEST  → STREAM_RESPONSE  → TOOL_CALL  → RENDER
```

| Stage             | Intent                                                                                                      | Terminates pass when…                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `RECEIVE_INPUT`   | Normalize input, assign correlation ID, persist to session history                                          | Always; passes through to `COMPOSE_REQUEST`                          |
| `COMPOSE_REQUEST` | Build the request: system prompt + history + tool defs + Context Provider output. Run compaction if needed. | Always; passes through                                               |
| `SEND_REQUEST`    | Dispatch to provider. Start cancel chain + correlation span.                                                | Always; passes through                                               |
| `STREAM_RESPONSE` | Consume provider stream: tokens, tool calls, finish reasons. Publish tokens on event bus.                   | Finish without tool call → `RENDER`; with tool call(s) → `TOOL_CALL` |
| `TOOL_CALL`       | Run the authority stack (SM → mode → guard → execute) per call. Serialize approval prompts.                 | Always returns to `COMPOSE_REQUEST` with results appended            |
| `RENDER`          | Persist the assistant response. Emit `SessionTurnEnd`. Hand the payload to the UI.                          | End of turn                                                          |

## Continuation loop

`COMPOSE_REQUEST → SEND_REQUEST → STREAM_RESPONSE → TOOL_CALL` may iterate any number of times within a single turn. Each iteration starts at `COMPOSE_REQUEST` with new tool results appended.

A turn ends when `STREAM_RESPONSE` finishes without emitting a tool call.

A **loop bound** applies per turn:

- **Default-chat turn.** Core enforces a session-level loop bound (configurable). Reaching it fires a terminal error.
- **SM stage execution.** The stage's `turnCap` is the bound. Checked at the top of each continuation iteration, before `COMPOSE_REQUEST`. If reached, in-flight tool calls complete but their results are **not** sent back to the LLM; `Act` ends with `capHit: true` and `Assert` receives the finalized transcript.

`turnCap` is a normal Act-ending branch — **not** a cancellation.

## Ownership

| Stage             | Core does                                   | Extensions may                                                 |
| ----------------- | ------------------------------------------- | -------------------------------------------------------------- |
| `RECEIVE_INPUT`   | Normalize, persist, emit `SessionTurnStart` | Transform / guard / observe input                              |
| `COMPOSE_REQUEST` | Assembly, compaction, tool list             | Transform composed request; feed context via Context Providers |
| `SEND_REQUEST`    | Invoke provider, start cancel chain         | Observe dispatch; transform wire-shape (rare)                  |
| `STREAM_RESPONSE` | Publish tokens, buffer tool calls           | Filter/observe tokens                                          |
| `TOOL_CALL`       | Approval gate, dispatch, serialize prompts  | Execute the tool; transform args; guard; observe               |
| `RENDER`          | Persist, emit `SessionTurnEnd`, hand to UI  | Transform render payload; observe                              |

**Core owns the shape of every stage.** Extensions never redefine stage boundaries.

## When an SM is attached

The message loop runs **inside** each SM stage execution. The stage's rendered body (from `Init`) becomes the system prompt, `allowedTools` narrows the tool manifest, and `turnCap` is the loop bound.

A sequential stage execution is itself a session turn. A parallel fan-out bundles siblings (+ optional `join`) into a compound turn.

See [`core/Stage-Executions.md`](../../../../stud-cli.wiki/core/Stage-Executions.md).

## Hook points

Every stage has `pre`/`post` hook points. Hooks are one of three kinds:

- `transform` — rewrite the stage's payload before the body runs (pre) or before the next stage (post).
- `guard` — refuse the stage with a typed error.
- `observer` — read-only; for audit, logging, metrics.

See [`contracts/Hooks.md`](../../../../stud-cli.wiki/contracts/Hooks.md).

## Events

Every transition emits a `StagePreFired` / `StagePostFired` event. `SessionTurnStart` / `SessionTurnEnd` bracket the turn. Events are projection only — do **not** route authoritative decisions through event subscription; use the Interaction Protocol, SM, or guard hooks.
