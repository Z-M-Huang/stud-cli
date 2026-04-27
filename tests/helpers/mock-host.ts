/**
 * `mockHost` — a frozen, per-extension `HostAPI` stub for test helpers.
 *
 * Key behaviours
 * ──────────────
 * • `host.session.stateSlot(extId)` returns a live in-memory handle for the
 *   caller's own `extId`.
 * • `host.session.stateSlot(otherExtId)` throws `ExtensionHost/SlotAccessDenied`
 *   and writes a `StateSlotAccessDenied` record to `recorders.audit`.
 * • `host.env.get(name)` resolves from `opts.env`; throws `Validation/EnvNameNotSet`
 *   for unknown names.  No `list`/`all`/`entries` surface (invariant #2).
 * • `host.events.emit(event, payload)` appends to `recorders.events`.
 * • `host.audit.write(record)` appends to `recorders.audit`.
 * • `host.config.readOwn()` merges `bundled → global → project` (project wins).
 * • Remaining surfaces are minimal no-op or error-throwing stubs.
 * • The returned `host` object is frozen via `Object.freeze`.
 *
 * Wiki: contracts/Extension-State.md + security/LLM-Context-Isolation.md
 */

import { ExtensionHost, Validation } from "../../src/core/errors/index.js";

import { createAuditRecorder, createEventRecorder } from "./event-recorder.js";

import type { AuditRecord, AuditRecorder, EventRecord, EventRecorder } from "./event-recorder.js";
import type { AuditAPI, AuditRecord as HostAuditRecord } from "../../src/core/host/api/audit.js";
import type { CommandsAPI } from "../../src/core/host/api/commands.js";
import type { ConfigAPI } from "../../src/core/host/api/config.js";
import type { EnvAPI } from "../../src/core/host/api/env.js";
import type { EventHandler, EventsAPI } from "../../src/core/host/api/events.js";
import type { InteractionAPI } from "../../src/core/host/api/interaction.js";
import type { MCPAPI } from "../../src/core/host/api/mcp.js";
import type { ObservabilityAPI } from "../../src/core/host/api/observability.js";
import type { PromptsAPI } from "../../src/core/host/api/prompts.js";
import type { ResourcesAPI } from "../../src/core/host/api/resources.js";
import type { SessionAPI, StateSlotHandle } from "../../src/core/host/api/session.js";
import type { ToolsAPI } from "../../src/core/host/api/tools.js";
import type { HostAPI } from "../../src/core/host/host-api.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MockHostOptions {
  /** The extension identity this host instance is scoped to. */
  readonly extId: string;
  /** Security mode. Defaults to `'ask'`. Session-fixed (invariant #3). */
  readonly mode?: "ask" | "yolo" | "allowlist";
  /** Absolute path returned by `session.projectRoot`. Defaults to `/fake/project/.stud`. */
  readonly projectRoot?: string;
  /** Stubs `EnvAPI.get` — only these names resolve; all others throw `EnvNameNotSet`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Stubs `ConfigAPI.readOwn` — scopes merged as bundled → global → project. */
  readonly config?: {
    readonly bundled?: Readonly<Record<string, unknown>>;
    readonly global?: Readonly<Record<string, unknown>>;
    readonly project?: Readonly<Record<string, unknown>>;
  };
  /** Initial content of the extension's state slot (returned by the first `read()`). */
  readonly initialState?: Readonly<Record<string, unknown>>;
}

export interface MockHostRecorders {
  /** Records every `host.events.emit(event, payload)` call. */
  readonly events: EventRecorder;
  /** Records every `host.audit.write(record)` call and cross-slot access denials. */
  readonly audit: AuditRecorder;
}

export interface MockHost {
  /** Frozen `HostAPI` instance scoped to `opts.extId`. */
  readonly host: HostAPI;
  /** Mutable recorders for snapshot assertions. */
  readonly recorders: MockHostRecorders;
}

// ---------------------------------------------------------------------------
// Internal types — expose push() for direct record injection in tests
// ---------------------------------------------------------------------------

interface InternalEventRecorder extends EventRecorder {
  push(record: EventRecord): void;
}

interface InternalAuditRecorder extends AuditRecorder {
  push(record: AuditRecord): void;
}

interface StubAPIs {
  readonly tools: ToolsAPI;
  readonly prompts: PromptsAPI;
  readonly resources: ResourcesAPI;
  readonly mcp: MCPAPI;
  readonly interaction: InteractionAPI;
  readonly commands: CommandsAPI;
}

// ---------------------------------------------------------------------------
// Internal builder helpers — keep mockHost() well under the 100-line cap
// ---------------------------------------------------------------------------

const STUB_MSG = "Not implemented in mock host";

function buildStateSlot(
  initialState: Readonly<Record<string, unknown>> | undefined,
): StateSlotHandle {
  let slotState: Readonly<Record<string, unknown>> | null = initialState ?? null;
  return {
    read(): Promise<Readonly<Record<string, unknown>> | null> {
      return Promise.resolve(slotState);
    },
    write(next: Readonly<Record<string, unknown>>): Promise<void> {
      slotState = next;
      return Promise.resolve();
    },
  };
}

function buildSession(
  callerExtId: string,
  opts: MockHostOptions,
  slotHandle: StateSlotHandle,
  auditRec: InternalAuditRecorder,
): SessionAPI {
  return {
    id: `mock-session-${callerExtId}`,
    mode: opts.mode ?? "ask",
    projectRoot: opts.projectRoot ?? "/fake/project/.stud",
    stateSlot(requestedExtId: string): StateSlotHandle {
      if (requestedExtId !== callerExtId) {
        // write audit record BEFORE throwing so it is always recorded
        auditRec.push({
          class: "StateSlotAccessDenied",
          extId: callerExtId,
          payload: { requestedExtId, callerExtId },
          at: Date.now(),
        });
        throw new ExtensionHost(
          `Extension '${callerExtId}' attempted to access slot of '${requestedExtId}'`,
          undefined,
          { code: "SlotAccessDenied", callerExtId, requestedExtId },
        );
      }
      return slotHandle;
    },
  };
}

function buildEvents(eventRec: InternalEventRecorder): EventsAPI {
  const handlerMap = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on<T = unknown>(event: string, handler: EventHandler<T>): void {
      const existing = handlerMap.get(event) ?? new Set<(payload: unknown) => void>();
      existing.add(handler as (payload: unknown) => void);
      handlerMap.set(event, existing);
    },
    off<T = unknown>(event: string, handler: EventHandler<T>): void {
      handlerMap.get(event)?.delete(handler as (payload: unknown) => void);
    },
    emit<T = unknown>(event: string, payload: T): void {
      eventRec.push({
        type: event,
        payload: payload as unknown as Readonly<Record<string, unknown>>,
        at: Date.now(),
      });
      handlerMap.get(event)?.forEach((h) => {
        h(payload);
      });
    },
  };
}

function buildConfig(opts: MockHostOptions): ConfigAPI {
  const merged: Record<string, unknown> = {
    ...opts.config?.bundled,
    ...opts.config?.global,
    ...opts.config?.project,
  };
  const frozenConfig: Readonly<Record<string, unknown>> = Object.freeze(merged);
  return {
    readOwn(): Promise<Readonly<Record<string, unknown>>> {
      return Promise.resolve(frozenConfig);
    },
  };
}

function buildEnv(opts: MockHostOptions): EnvAPI {
  return {
    get(name: string): Promise<string> {
      const envMap = opts.env;
      if (envMap === undefined) {
        throw new Validation(`Environment variable '${name}' is not set`, undefined, {
          code: "EnvNameNotSet",
          name,
        });
      }
      // eslint-disable-next-line security/detect-object-injection
      const value: string | undefined = envMap[name];
      if (value === undefined) {
        throw new Validation(`Environment variable '${name}' is not set`, undefined, {
          code: "EnvNameNotSet",
          name,
        });
      }
      return Promise.resolve(value);
    },
  };
}

function buildAudit(callerExtId: string, auditRec: InternalAuditRecorder): AuditAPI {
  return {
    write(record: HostAuditRecord): Promise<void> {
      const contextPart: Readonly<Record<string, unknown>> = record.context ?? {};
      const payload: Record<string, unknown> = {
        severity: record.severity,
        message: record.message,
        ...contextPart,
      };
      auditRec.push({
        class: record.code,
        extId: callerExtId,
        payload: Object.freeze(payload),
        at: Date.now(),
      });
      return Promise.resolve();
    },
  };
}

function buildObservability(eventRec: InternalEventRecorder): ObservabilityAPI {
  return {
    emit<T = unknown>(event: { readonly type: string; readonly payload: T }): void {
      eventRec.push({
        type: event.type,
        payload: event.payload as unknown as Readonly<Record<string, unknown>>,
        at: Date.now(),
      });
    },
    suppress(event): void {
      eventRec.push({
        type: "SuppressedError",
        payload: event as unknown as Readonly<Record<string, unknown>>,
        at: Date.now(),
      });
    },
  };
}

function buildStubs(): StubAPIs {
  const tools: ToolsAPI = { list: () => [], get: () => undefined };
  const prompts: PromptsAPI = {
    resolveByURI(_uri: string) {
      throw new ExtensionHost(STUB_MSG, undefined, { code: "NotImplemented" });
    },
  };
  const resources: ResourcesAPI = {
    fetch(_uri: string) {
      throw new ExtensionHost(STUB_MSG, undefined, { code: "NotImplemented" });
    },
  };
  const mcp: MCPAPI = {
    listServers: () => [],
    listTools: () => [],
    callTool(_s: string, _t: string, _a: Readonly<Record<string, unknown>>) {
      throw new ExtensionHost(STUB_MSG, undefined, { code: "NotImplemented" });
    },
  };
  const interaction: InteractionAPI = {
    raise(_req) {
      throw new ExtensionHost(STUB_MSG, undefined, { code: "NotImplemented" });
    },
  };
  const commands: CommandsAPI = {
    dispatch(_name: string, _args?: Readonly<Record<string, unknown>>) {
      throw new ExtensionHost(STUB_MSG, undefined, { code: "NotImplemented" });
    },
  };
  return { tools, prompts, resources, mcp, interaction, commands };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a frozen `HostAPI` stub scoped to `opts.extId`.
 *
 * @returns `{ host, recorders }` — the frozen host and its associated
 *   event/audit recorders for test assertions.
 */
export function mockHost(opts: MockHostOptions): MockHost {
  const callerExtId = opts.extId;
  const eventRec = createEventRecorder() as unknown as InternalEventRecorder;
  const auditRec = createAuditRecorder() as unknown as InternalAuditRecorder;

  const slotHandle = buildStateSlot(opts.initialState);
  const session = buildSession(callerExtId, opts, slotHandle, auditRec);
  const events = buildEvents(eventRec);
  const config = buildConfig(opts);
  const env = buildEnv(opts);
  const audit = buildAudit(callerExtId, auditRec);
  const observability = buildObservability(eventRec);
  const { tools, prompts, resources, mcp, interaction, commands } = buildStubs();

  const host: HostAPI = Object.freeze({
    session,
    events,
    config,
    env,
    tools,
    prompts,
    resources,
    mcp,
    audit,
    observability,
    interaction,
    commands,
  });

  return {
    host,
    recorders: {
      events: eventRec as unknown as EventRecorder,
      audit: auditRec as unknown as AuditRecorder,
    },
  };
}
