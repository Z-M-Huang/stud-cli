import { ExtensionHost, Session, Validation } from "../errors/index.js";

import type { HostAPI } from "../host/host-api.js";
import type { StateSlot } from "../lifecycle/extension-state.js";

export interface AttachArgs {
  readonly smId: string;
  readonly host: HostAPI;
  readonly deliveredSlot: StateSlot<unknown> | null;
  readonly resumed: boolean;
}

export interface AttachResult {
  readonly smId: string;
  readonly sawSlot: boolean;
  readonly attachedAt: number;
}

interface AttachRuntime {
  readonly attach?: (host: HostAPI) => Promise<void> | void;
  readonly setAttachedStateMachine?: (input: {
    readonly smId: string;
    readonly deliveredSlot: StateSlot<unknown> | null;
  }) => void;
}

interface HostWithSMRuntime extends HostAPI {
  readonly smRuntime?: AttachRuntime;
}

const attachedByHost = new WeakMap<HostAPI, string>();

function asStoredSlot(slot: StateSlot<unknown>): Readonly<Record<string, unknown>> {
  return {
    slotVersion: slot.slotVersion,
    data: slot.data,
  };
}

function slotsEqual(
  left: Readonly<Record<string, unknown>> | null,
  right: StateSlot<unknown> | null,
): boolean {
  if (left === null || right === null) {
    return left === null && right === null;
  }

  return (
    left["slotVersion"] === right.slotVersion &&
    JSON.stringify(left["data"] ?? null) === JSON.stringify(right.data ?? null)
  );
}

async function deliverSlot(
  host: HostAPI,
  smId: string,
  deliveredSlot: StateSlot<unknown> | null,
  resumed: boolean,
): Promise<void> {
  if (!resumed) {
    return;
  }
  if (deliveredSlot === null) {
    throw new Session("resumed state machine is missing its delivered slot", undefined, {
      code: "ResumeMismatch",
      smId,
    });
  }

  await host.session.stateSlot(smId).write(asStoredSlot(deliveredSlot));
}

async function verifyDeliveredSlot(
  host: HostAPI,
  smId: string,
  deliveredSlot: StateSlot<unknown> | null,
  resumed: boolean,
): Promise<boolean> {
  const stored = await host.session.stateSlot(smId).read();
  if (resumed && !slotsEqual(stored, deliveredSlot)) {
    throw new Session("resumed state machine slot was not delivered before attach", undefined, {
      code: "ResumeMismatch",
      smId,
    });
  }

  return stored !== null;
}

function wireAttachedStateMachine(
  host: HostWithSMRuntime,
  smId: string,
  deliveredSlot: StateSlot<unknown> | null,
): void {
  host.smRuntime?.setAttachedStateMachine?.({ smId, deliveredSlot });
}

async function emitAttached(
  host: HostAPI,
  smId: string,
  resumed: boolean,
  sawSlot: boolean,
): Promise<void> {
  const payload = { smId, resumed, sawSlot };
  host.events.emit("SMAttached", payload);
  await host.audit.write({
    severity: "info",
    code: "SMAttached",
    message: `State machine '${smId}' attached`,
    context: payload,
  });
}

export async function attachSM(args: AttachArgs): Promise<AttachResult> {
  const { smId, host, deliveredSlot, resumed } = args;

  const attachedSmId = attachedByHost.get(host);
  if (attachedSmId !== undefined && attachedSmId !== smId) {
    throw new Validation(`state machine '${attachedSmId}' is already attached`, undefined, {
      code: "SMAlreadyAttached",
      attachedSmId,
      requestedSmId: smId,
    });
  }

  await deliverSlot(host, smId, deliveredSlot, resumed);
  const sawSlot = await verifyDeliveredSlot(host, smId, deliveredSlot, resumed);

  const runtimeHost = host as HostWithSMRuntime;
  try {
    await runtimeHost.smRuntime?.attach?.(host);
  } catch (error) {
    throw new ExtensionHost(`attach failed for state machine '${smId}'`, error, {
      code: "LifecycleFailure",
      smId,
      phase: "attach",
    });
  }

  attachedByHost.set(host, smId);
  wireAttachedStateMachine(runtimeHost, smId, deliveredSlot);

  const attachedAt = Date.now();
  await emitAttached(host, smId, resumed, sawSlot);

  return {
    smId,
    sawSlot,
    attachedAt,
  };
}
