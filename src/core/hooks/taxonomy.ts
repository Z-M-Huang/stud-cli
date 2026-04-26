import { Validation } from "../errors/validation.js";

import {
  HOOK_SLOT_MATRIX,
  type HookPosition,
  type HookSlot,
  type HookSlotRule,
  type HookStage,
  type HookSubKind,
} from "./slot-matrix.js";

export type { HookPosition, HookSlot, HookStage, HookSubKind };

const SLOT_PATTERN =
  /^(?:RECEIVE_INPUT|COMPOSE_REQUEST|SEND_REQUEST|STREAM_RESPONSE|TOOL_CALL|RENDER)\/(?:pre|post)$/;

const MATRIX_BY_SLOT: ReadonlyMap<HookSlot, HookSlotRule> = new Map(
  HOOK_SLOT_MATRIX.map((rule) => [rule.slot, rule]),
);

export { HOOK_SLOT_MATRIX };
export type { HookSlotRule };

export function listSlots(): readonly HookSlot[] {
  return HOOK_SLOT_MATRIX.map((rule) => rule.slot);
}

export function isAttachmentAllowed(slot: HookSlot, subKind: HookSubKind): boolean {
  return MATRIX_BY_SLOT.get(slot)?.allowed.includes(subKind) ?? false;
}

export function validateAttachment(slot: HookSlot, subKind: HookSubKind): void {
  if (!SLOT_PATTERN.test(slot)) {
    throw new Validation(`Unknown hook slot '${slot}'`, undefined, {
      code: "HookSlotUnknown",
      slot,
    });
  }

  const rule = MATRIX_BY_SLOT.get(slot);

  if (rule === undefined) {
    throw new Validation(`Unknown hook slot '${slot}'`, undefined, {
      code: "HookSlotUnknown",
      slot,
    });
  }

  if (!rule.allowed.includes(subKind)) {
    const matrixLine = HOOK_SLOT_MATRIX.findIndex((entry) => entry.slot === slot) + 1;
    throw new Validation(
      `Hook sub-kind '${subKind}' is not permitted at slot '${slot}' by matrix line ${String(matrixLine)}`,
      undefined,
      {
        code: "HookInvalidAttachment",
        slot,
        subKind,
        matrixLine,
      },
    );
  }
}
