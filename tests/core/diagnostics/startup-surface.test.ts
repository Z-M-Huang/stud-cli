import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildStartupSurface,
  formatSurfaceLine,
} from "../../../src/core/diagnostics/startup-surface.js";
import { resetOutcomes, registerOutcome } from "../../../src/core/discovery/outcome-registrar.js";

import type { ValidationOutcome } from "../../../src/core/discovery/validator.js";

describe("startup surface", () => {
  it("counts loaded vs disabled from the outcome registrar", () => {
    primeOutcomes([
      { id: "a", kind: "providers", scope: "bundled", status: "ok", failures: [] },
      {
        id: "b",
        kind: "tools",
        scope: "global",
        status: "disabled",
        failures: [
          {
            stage: "configSchema",
            severity: "error",
            message: "enabled: expected boolean",
            path: "/enabled",
          },
        ],
      },
    ]);

    const surface = buildStartupSurface();

    assert.equal(surface.loadedCount, 1);
    assert.equal(surface.disabledCount, 1);
  });

  it("disabled entries carry stage and fieldPath per AC-30", () => {
    primeOutcomes([
      {
        id: "x",
        kind: "hooks",
        scope: "project",
        status: "disabled",
        failures: [
          {
            stage: "shape",
            severity: "error",
            message: "missing contractVersion",
            path: "/contractVersion",
          },
        ],
      },
    ]);

    const surface = buildStartupSurface();

    assert.equal(surface.disabled[0]?.stage, "shape");
    assert.equal(surface.disabled[0]?.fieldPath, "/contractVersion");
  });

  it("records a project→global fallback per Q-3 revision", () => {
    primeOutcomes([
      {
        id: "p",
        kind: "tools",
        scope: "project",
        status: "disabled",
        fallbackFrom: "g",
        failures: [
          {
            stage: "configSchema",
            severity: "warning",
            message: "invalid config",
            path: "/x",
          },
        ],
      },
    ]);

    const surface = buildStartupSurface();
    const entry = surface.disabled.find((candidate) => candidate.extensionId === "p");

    assert.equal(entry?.fallback?.toScope, "global");
    assert.equal(entry?.fallback?.fromExtensionId, "g");
  });

  it("formatSurfaceLine renders scope/id (kind): stage — message", () => {
    const line = formatSurfaceLine({
      extensionId: "x",
      kind: "tools",
      scope: "global",
      stage: "contractVersion",
      message: "incompatible",
    });

    assert.equal(line, "global/x (tools): contractVersion — incompatible");
  });

  it("is a projection (reading twice yields the same surface)", () => {
    primeOutcomes([{ id: "a", kind: "providers", scope: "bundled", status: "ok", failures: [] }]);

    assert.equal(JSON.stringify(buildStartupSurface()), JSON.stringify(buildStartupSurface()));
  });

  it("refuses when Unit 75 has not populated outcomes", () => {
    resetOutcomes();

    assert.throws(
      () => buildStartupSurface(),
      (error): boolean =>
        error instanceof Error &&
        "class" in error &&
        error.class === "Session" &&
        "context" in error &&
        typeof error.context === "object" &&
        error.context !== null &&
        "code" in error.context &&
        error.context.code === "ValidationNotRun",
    );
  });
});

function primeOutcomes(outcomes: readonly ValidationOutcome[]): void {
  resetOutcomes();

  for (const outcome of outcomes) {
    registerOutcome(outcome);
  }
}
