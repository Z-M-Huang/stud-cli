import type { MergedOrdering } from "./ordering-manifest.js";
import type { HookHandle } from "./runner.js";
import type { HookSlot } from "./taxonomy.js";

export function orderHooksForSlot(
  hooks: readonly HookHandle[],
  ordering: MergedOrdering,
  slot: HookSlot,
): readonly HookHandle[] {
  const manifestOrder = getManifestOrder(ordering, slot);
  const manifestIndex = new Map<string, number>(
    manifestOrder.map((extensionId, index) => [extensionId, index]),
  );

  return [...hooks]
    .filter((hook) => hook.slot === slot)
    .sort((left, right) => {
      const leftIndex = manifestIndex.get(left.extensionId);
      const rightIndex = manifestIndex.get(right.extensionId);

      if (leftIndex !== undefined && rightIndex !== undefined) {
        return leftIndex - rightIndex;
      }

      if (leftIndex !== undefined) {
        return -1;
      }

      if (rightIndex !== undefined) {
        return 1;
      }

      return left.extensionId.localeCompare(right.extensionId);
    });
}

function getManifestOrder(ordering: MergedOrdering, slot: HookSlot): readonly string[] {
  const perSlot = ordering.perSlot;

  switch (slot) {
    case "RECEIVE_INPUT/pre":
      return perSlot["RECEIVE_INPUT/pre"] ?? [];
    case "RECEIVE_INPUT/post":
      return perSlot["RECEIVE_INPUT/post"] ?? [];
    case "COMPOSE_REQUEST/pre":
      return perSlot["COMPOSE_REQUEST/pre"] ?? [];
    case "COMPOSE_REQUEST/post":
      return perSlot["COMPOSE_REQUEST/post"] ?? [];
    case "SEND_REQUEST/pre":
      return perSlot["SEND_REQUEST/pre"] ?? [];
    case "SEND_REQUEST/post":
      return perSlot["SEND_REQUEST/post"] ?? [];
    case "STREAM_RESPONSE/pre":
      return perSlot["STREAM_RESPONSE/pre"] ?? [];
    case "STREAM_RESPONSE/post":
      return perSlot["STREAM_RESPONSE/post"] ?? [];
    case "TOOL_CALL/pre":
      return perSlot["TOOL_CALL/pre"] ?? [];
    case "TOOL_CALL/post":
      return perSlot["TOOL_CALL/post"] ?? [];
    case "RENDER/pre":
      return perSlot["RENDER/pre"] ?? [];
    case "RENDER/post":
      return perSlot["RENDER/post"] ?? [];
  }
}
