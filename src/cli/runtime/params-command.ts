/**
 * `/params` slash command — read or mutate the session's runtime provider
 * params bag.
 *
 * Wiki: contracts/Commands.md § "/params mutation profile";
 *       core/Event-and-Command-Ordering.md § "/params turn-safety" (mid-Act refusal);
 *       operations/Audit-Trail.md § "Audit records as redacted deltas" + "Params" class.
 *
 * Read mode (no arguments): prints the effective merged view, values redacted.
 * Write mode (`<path>=<value> ...`, repeatable): validates each pair via the
 * Provider-Params seven-check pipeline, sets the override (`sourceLayer:
 * "/params"`), audits one redacted delta per path, emits one `ParamsChanged`
 * event per mutated path.
 */
import { randomUUID } from "node:crypto";

import { assertProviderParamsValid } from "../../contracts/provider-params.js";
import { parseLaunchParam } from "../launch-args.js";

import { redactedDelta } from "./params-redact.js";
import { validatePerProtocolParams } from "./params-validator.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { SessionBootstrap } from "./types.js";
import type { HostAPI } from "../../core/host/host-api.js";

export interface ParamsCommandResult {
  readonly kind: "ok" | "rejected" | "noop";
  readonly notify: string;
  readonly reason?: { readonly code: string; readonly message: string };
}

export interface DispatchParamsCommandInput {
  readonly session: SessionBootstrap;
  readonly auditBus: SessionAuditBus;
  /**
   * Host API — used to emit `ParamsChanged` on the event bus per
   * `wiki/core/Event-Bus.md:118`. Optional for unit tests that don't need
   * event-bus wiring.
   */
  readonly host?: HostAPI;
  /**
   * Active SM stage step, when an SM is attached. `/params` is refused with
   * `StageActive` when this is `"Act"`. Per
   * `wiki/core/Event-and-Command-Ordering.md:44`. `null` when no SM is
   * attached (the v1 default — the loop has no SM plumbing).
   */
  readonly activeStageStep?: "Init" | "Setup" | "Act" | "Assert" | "Exit" | null;
  /** The arguments after `/params`, e.g. `["effort=high", "topP=0.9"]`. */
  readonly tokens: readonly string[];
}

export function dispatchParamsCommand(input: DispatchParamsCommandInput): ParamsCommandResult {
  // Mid-Act refusal per `wiki/core/Event-and-Command-Ordering.md:44`.
  if (input.activeStageStep === "Act") {
    return {
      kind: "rejected",
      notify: "/params is refused while an SM stage is mid-Act",
      reason: { code: "StageActive", message: "stage is mid-Act; /params not allowed" },
    };
  }

  // Read mode — print the effective merged view, values redacted.
  if (input.tokens.length === 0) {
    const eff = input.session.paramsStore.getEffective();
    const lines = Object.entries(eff)
      .map(
        ([key, entry]) =>
          `${key}=${JSON.stringify(redactedDelta(entry.value))}\t[${entry.sourceLayer}]`,
      )
      .sort();
    return {
      kind: "ok",
      notify: lines.length === 0 ? "(no params set)" : lines.join("\n"),
    };
  }

  // Write mode — parse each token, validate, set, audit, emit ParamsChanged.
  const sel = input.session.selection.current();
  const writes: {
    readonly path: readonly string[];
    readonly value: unknown;
    readonly raw: string;
  }[] = [];
  for (const token of input.tokens) {
    const parsed = parseLaunchParam(token);
    writes.push(parsed);
  }

  // Apply writes optimistically into a copy via re-validation. We validate the
  // resulting bag once with all writes applied; on validation failure, no
  // writes are persisted (atomic mutation per `/params` semantics).
  const projected: Record<string, unknown> = { ...input.session.paramsStore.asMergedBag() };
  for (const w of writes) {
    setNestedPath(projected, w.path, w.value);
  }
  const report = validatePerProtocolParams({
    protocol: sel.protocolId,
    params: projected,
    modelId: sel.modelId,
    sourceLayer: "/params",
  });
  try {
    assertProviderParamsValid(report, {
      entryId: sel.entryId,
      protocol: sel.protocolId,
      modelId: sel.modelId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "validation failed";
    return {
      kind: "rejected",
      notify: `/params validation failed: ${message}`,
      reason: { code: "ParamValidationFailed", message },
    };
  }

  // Persist writes; emit one `ParamsChanged` event per path on BOTH the
  // host event bus (projection-only — subscribers may rerender) AND the
  // audit bus (durable redacted-delta record). Per `wiki/core/Event-Bus.md:118`
  // — one event per mutated path with `{paramPath, sourceLayer, redactedDelta,
  // correlationId}`. Per `wiki/operations/Audit-Trail.md:66`.
  // The correlationId is the per-invocation identifier so all paths mutated
  // by a single `/params` call share a correlation.
  const correlationId = `params:${randomUUID()}`;
  for (const w of writes) {
    input.session.paramsStore.set(w.path, w.value, "/params");
    const redacted = redactedDelta(w.value);
    input.host?.events.emit("ParamsChanged", {
      paramPath: w.path,
      sourceLayer: "/params",
      redactedDelta: redacted,
      correlationId,
    });
    input.auditBus.emit("Params", {
      kind: "ParamsChanged",
      paramPath: w.path,
      sourceLayer: "/params",
      redactedValue: redacted,
    });
  }
  // Single notify line summarizing the mutations.
  const summary = writes
    .map((w) => `${w.path.join(".")}=${JSON.stringify(redactedDelta(w.value))}`)
    .join(", ");
  return {
    kind: "ok",
    notify: `params updated: ${summary}`,
  };
}

function setNestedPath(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i]!;
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]!] = value;
}
