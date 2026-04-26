# Ralph SM fixture project

Minimal scaffold the Ralph reference State Machine walks during its UAT.

The fixture is intentionally small:

- `src/index.ts` — a one-line module the Build stages may inspect or modify.
- A real workflow would clone this directory, attach the Ralph SM, and step
  through Discovery → Decompose → Build → JoinReview → Complete.

This directory exists to satisfy the examples-check parity gate; it is not
exercised by automated tests in v1 (a true end-to-end UAT requires the live
session orchestrator).
