/**
 * Bootstrap-time emission helpers for the session loop.
 *
 * Wiki: flows/Session-Resume.md § "Provider params not persisted",
 *       § "Manifest size threshold";
 *       operations/Audit-Trail.md § "Params" class;
 *       core/Event-Bus.md (ParamsChanged + ManifestSizeBudgetExceeded payloads).
 *
 * Each helper accepts the host-and-audit pair from `bootstrapSessionContext`
 * and emits the bootstrap-time events: pre-hydration manifest-size budget,
 * prior-session runtime overrides surfacing, and launch-time --param audit.
 */
import { randomUUID } from "node:crypto";

import { checkManifestSizeBudget, manifestSizeBudgetPayload } from "./manifest-size-budget.js";
import { redactedDelta } from "./params-redact.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { SessionBootstrap } from "./types.js";
import type { HostAPI } from "../../core/host/host-api.js";

export function emitPreHydrationSizeBudget(
  session: SessionBootstrap,
  host: HostAPI,
  auditBus: SessionAuditBus,
): void {
  if (!session.resumed) return;
  const sizeCheck = checkManifestSizeBudget(session.manifest);
  if (!sizeCheck.exceeded) return;
  const payload = manifestSizeBudgetPayload("pre-hydration", sizeCheck);
  host.events.emit("ManifestSizeBudgetExceeded", payload);
  auditBus.emit("ManifestSizeBudgetExceeded", { ...payload });
}

export function emitPriorRuntimeOverridesSurface(
  session: SessionBootstrap,
  host: HostAPI,
  auditBus: SessionAuditBus,
): void {
  if (!session.resumed || session.priorRuntimeOverrides === undefined) return;
  for (const override of session.priorRuntimeOverrides) {
    host.events.emit("RuntimeParamsNotResumed", {
      paramPath: override.paramPath,
      sourceLayer: override.sourceLayer,
      redactedValue: override.redactedValue,
    });
    auditBus.emit("Params", {
      kind: "RuntimeParamsNotResumed",
      paramPath: override.paramPath,
      sourceLayer: override.sourceLayer,
      redactedValue: override.redactedValue,
    });
  }
}

export function emitLaunchOverrideAudit(
  session: SessionBootstrap,
  host: HostAPI,
  auditBus: SessionAuditBus,
): void {
  const launchOverrides = session.paramsStore
    .snapshot()
    .filter((entry) => entry.sourceLayer === "launch");
  if (launchOverrides.length === 0) return;
  const correlationId = `launch:${randomUUID()}`;
  for (const entry of launchOverrides) {
    const redacted = redactedDelta(entry.value);
    host.events.emit("ParamsChanged", {
      paramPath: entry.paramPath,
      sourceLayer: "launch",
      redactedDelta: redacted,
      correlationId,
    });
    auditBus.emit("Params", {
      kind: "ParamsChanged",
      paramPath: entry.paramPath,
      sourceLayer: "launch",
      redactedValue: redacted,
    });
  }
}
