/**
 * Stage executions orchestrator — seven-phase per-stage runner.
 *
 * Wiki: core/Stage-Executions.md
 */

import { Cancellation, ExtensionHost, Validation } from "../errors/index.js";

import type { StageDefinition } from "../../contracts/state-machines.js";
import type { HostAPI } from "../host/host-api.js";

export type StagePhase = "Setup" | "Init" | "CheckGate" | "Act" | "Assert" | "Exit" | "Next";

export interface StageExecutionId {
  readonly sessionId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly parentCompoundTurnId?: string;
}

export interface StageExecutionInput {
  readonly stageId: string;
  readonly ctx: Readonly<Record<string, unknown>>;
  readonly attempt: number;
}

export interface StageTranscriptEntry {
  readonly phase: StagePhase;
  readonly detail?: unknown;
}

export interface StageLocalTranscript {
  readonly entries: readonly StageTranscriptEntry[];
  readonly renderedBody?: string;
}

export type NextResult =
  | { readonly execution: "sequential"; readonly stageIds: readonly string[] }
  | {
      readonly execution: "parallel";
      readonly stageIds: readonly string[];
      readonly join?: string;
    }
  | { readonly execution: "terminate" };

export interface StageExecutionResult {
  readonly id: StageExecutionId;
  readonly capHit: boolean;
  readonly assertOutcome: "ok" | "retry" | "skip" | "fail";
  readonly nextResult: NextResult;
  readonly transcript: StageLocalTranscript;
}

interface InternalStageExecutionInput extends StageExecutionInput {
  readonly parentCompoundTurnId?: string;
}

interface StageActResult {
  readonly capHit: boolean;
  readonly transcript?: readonly StageTranscriptEntry[];
}

interface RuntimeStage extends StageDefinition {
  readonly setup?: (ctx: Record<string, unknown>, host: HostAPI) => Promise<void> | void;
  readonly init?: (
    ctx: Readonly<Record<string, unknown>>,
    host: HostAPI,
  ) => Promise<string> | string;
  readonly checkGate?: (
    ctx: Readonly<Record<string, unknown>>,
    host: HostAPI,
  ) => Promise<"proceed" | "retry" | "skip"> | "proceed" | "retry" | "skip";
  readonly assert?: (
    ctx: Readonly<Record<string, unknown>>,
    act: StageActResult,
    host: HostAPI,
  ) => Promise<"ok" | "retry" | "skip" | "fail"> | "ok" | "retry" | "skip" | "fail";
  readonly exit?: (
    ctx: Readonly<Record<string, unknown>>,
    result: {
      readonly assertOutcome: StageExecutionResult["assertOutcome"];
      readonly nextResult: NextResult;
    },
    host: HostAPI,
  ) => Promise<void> | void;
}

interface StageRuntimeHost extends HostAPI {
  readonly smRuntime: {
    resolveStage(stageId: string): RuntimeStage;
    executeAct(args: {
      readonly executionId: StageExecutionId;
      readonly stage: RuntimeStage;
      readonly ctx: Readonly<Record<string, unknown>>;
      readonly renderedBody: string;
      readonly signal: AbortSignal;
    }): Promise<StageActResult>;
  };
}

function asRuntimeHost(host: HostAPI): StageRuntimeHost {
  const runtimeHost = host as Partial<StageRuntimeHost>;
  if (runtimeHost.smRuntime === undefined) {
    throw new ExtensionHost("SM runtime is not attached", undefined, {
      code: "LifecycleFailure",
      reason: "MissingSMRuntime",
    });
  }
  return runtimeHost as StageRuntimeHost;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Cancellation("stage cancelled", undefined, { code: "StageCancelled" });
  }
}

async function withCancellation<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  throwIfAborted(signal);
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Cancellation("stage cancelled", undefined, { code: "StageCancelled" })),
      { once: true },
    );
  });
  return Promise.race([work, aborted]);
}

function emitPhase(
  host: HostAPI,
  kind: "pre" | "post",
  phase: StagePhase,
  id: StageExecutionId,
): void {
  const event = kind === "pre" ? "StagePreFired" : "StagePostFired";
  host.events.emit(event, {
    phase,
    stageId: id.stageId,
    attempt: id.attempt,
    sessionId: id.sessionId,
    parentCompoundTurnId: id.parentCompoundTurnId,
  });
}

function readonlyCtx(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  return new Proxy(value, {
    get(target, prop, receiver) {
      return readonlyCtx(Reflect.get(target, prop, receiver));
    },
    set() {
      throw new Validation("stage context is read-only outside Setup", undefined, {
        code: "ContextMutationForbidden",
      });
    },
    deleteProperty() {
      throw new Validation("stage context is read-only outside Setup", undefined, {
        code: "ContextMutationForbidden",
      });
    },
    defineProperty() {
      throw new Validation("stage context is read-only outside Setup", undefined, {
        code: "ContextMutationForbidden",
      });
    },
  });
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

function readCtxValue(ctx: Readonly<Record<string, unknown>>, key: string): string {
  if (!Object.hasOwn(ctx, key)) {
    return "";
  }
  return renderValue(ctx[key]);
}

function renderBody(body: string, ctx: Readonly<Record<string, unknown>>): string {
  return body.replaceAll(/\$\{ctx\.(\w+)\}/g, (_match, key: string) => readCtxValue(ctx, key));
}

function normalizeNextResult(next: {
  readonly execution: string;
  readonly nextStages?: readonly string[];
  readonly join?: string;
}): NextResult {
  if (next.execution === "parallel") {
    return next.join === undefined
      ? { execution: "parallel", stageIds: next.nextStages ?? [] }
      : { execution: "parallel", stageIds: next.nextStages ?? [], join: next.join };
  }
  if ((next.nextStages ?? []).length > 0) {
    return { execution: "sequential", stageIds: next.nextStages ?? [] };
  }
  return { execution: "terminate" };
}

function makeExecutionId(input: InternalStageExecutionInput, host: HostAPI): StageExecutionId {
  return input.parentCompoundTurnId === undefined
    ? {
        sessionId: host.session.id,
        stageId: input.stageId,
        attempt: input.attempt,
      }
    : {
        sessionId: host.session.id,
        stageId: input.stageId,
        attempt: input.attempt,
        parentCompoundTurnId: input.parentCompoundTurnId,
      };
}

async function runOwnedPhase<T>(
  phase: StagePhase,
  id: StageExecutionId,
  host: HostAPI,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  emitPhase(host, "pre", phase, id);
  try {
    const result = await withCancellation(signal, work());
    emitPhase(host, "post", phase, id);
    return result;
  } catch (error) {
    emitPhase(host, "post", phase, id);
    if (
      error instanceof Validation ||
      error instanceof Cancellation ||
      error instanceof ExtensionHost
    ) {
      throw error;
    }
    throw new ExtensionHost(`stage phase '${phase}' failed`, error, {
      code: "LifecycleFailure",
      phase,
      stageId: id.stageId,
    });
  }
}

export async function runStage(
  input: StageExecutionInput,
  host: HostAPI,
  signal: AbortSignal,
): Promise<StageExecutionResult> {
  const runtimeHost = asRuntimeHost(host);
  const internalInput = input as InternalStageExecutionInput;
  const stage = runtimeHost.smRuntime.resolveStage(input.stageId);
  const id = makeExecutionId(internalInput, host);

  host.observability.emit({
    type: "StageExecutionSpanStart",
    payload: { sessionId: id.sessionId, stageId: id.stageId, attempt: id.attempt },
  });

  const entries: StageTranscriptEntry[] = [];
  const mutableCtx: Record<string, unknown> = { ...input.ctx };
  let renderedBody = stage.body;
  let capHit = false;
  let assertOutcome: StageExecutionResult["assertOutcome"] = "ok";
  let nextResult: NextResult = { execution: "terminate" };

  await runOwnedPhase("Setup", id, host, signal, async () => {
    await stage.setup?.(mutableCtx, host);
    entries.push({ phase: "Setup", detail: { ctx: { ...mutableCtx } } });
  });

  const roCtx = readonlyCtx(mutableCtx) as Readonly<Record<string, unknown>>;

  await runOwnedPhase("Init", id, host, signal, async () => {
    renderedBody = stage.init ? await stage.init(roCtx, host) : renderBody(stage.body, roCtx);
    entries.push({ phase: "Init", detail: { renderedBody } });
  });

  const gateVerdict = await runOwnedPhase("CheckGate", id, host, signal, async () => {
    const verdict = (await stage.checkGate?.(roCtx, host)) ?? "proceed";
    entries.push({ phase: "CheckGate", detail: { verdict } });
    return verdict;
  });

  const actResult = await runOwnedPhase("Act", id, host, signal, async () => {
    if (gateVerdict !== "proceed") {
      const skipped: StageActResult = { capHit: false, transcript: [] };
      entries.push({ phase: "Act", detail: { skipped: true, because: gateVerdict } });
      return skipped;
    }

    const result = await runtimeHost.smRuntime.executeAct({
      executionId: id,
      stage,
      ctx: roCtx,
      renderedBody,
      signal,
    });

    capHit = result.capHit;
    entries.push({ phase: "Act", detail: { capHit: result.capHit } });
    for (const entry of result.transcript ?? []) entries.push(entry);
    return result;
  });

  await runOwnedPhase("Assert", id, host, signal, async () => {
    if (gateVerdict === "retry" || gateVerdict === "skip") {
      assertOutcome = gateVerdict;
    } else {
      assertOutcome = (await stage.assert?.(roCtx, actResult, host)) ?? (capHit ? "retry" : "ok");
    }
    entries.push({ phase: "Assert", detail: { assertOutcome } });
  });

  await runOwnedPhase("Exit", id, host, signal, async () => {
    nextResult = normalizeNextResult(await stage.next(roCtx));
    await stage.exit?.(roCtx, { assertOutcome, nextResult }, host);
    host.events.emit("SessionTurnEnd", {
      stageId: id.stageId,
      execution: nextResult.execution,
      parentCompoundTurnId: id.parentCompoundTurnId,
    });
    entries.push({ phase: "Exit", detail: { execution: nextResult.execution } });
  });

  await runOwnedPhase("Next", id, host, signal, () => {
    entries.push({ phase: "Next", detail: nextResult });
    return Promise.resolve();
  });

  return {
    id,
    capHit,
    assertOutcome,
    nextResult,
    transcript: { entries, renderedBody },
  };
}
