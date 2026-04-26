import { readFile } from "node:fs/promises";

import { Session } from "../errors/session.js";
import { Validation } from "../errors/validation.js";

import { HOOK_SLOT_MATRIX } from "./taxonomy.js";

import type {
  MergedOrdering,
  OrderingManifest,
  OrderingManifestByScope,
  OrderingRewrite,
} from "./ordering-manifest.js";
import type { HookSlot, HookSlotRule, HookSubKind } from "./taxonomy.js";

export { diffOrdering } from "./diff.js";

const RULES_BY_SLOT: ReadonlyMap<HookSlot, HookSlotRule> = new Map(
  HOOK_SLOT_MATRIX.map((rule) => [rule.slot, rule]),
);

assertCanonicalHookMatrix();

export async function loadOrderingManifest(
  orderingJsonPath: string,
): Promise<OrderingManifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(orderingJsonPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Session("failed to read ordering manifest", err, {
      code: "OrderingManifestUnreadable",
      path: orderingJsonPath,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Validation("ordering manifest is malformed", err, {
      code: "OrderingManifestMalformed",
      path: orderingJsonPath,
    });
  }

  return validateOrderingManifest(parsed, orderingJsonPath);
}

export function mergeOrdering(byScope: OrderingManifestByScope): MergedOrdering {
  const perSlot: Partial<Record<HookSlot, readonly string[]>> = {};
  const rewrites: OrderingRewrite[] = [];

  applyScope(perSlot, rewrites, byScope.bundled, undefined);
  applyScope(perSlot, rewrites, byScope.global, "global");
  applyScope(perSlot, rewrites, byScope.project, "project");

  return { perSlot, rewrites };
}

function applyScope(
  perSlot: Partial<Record<HookSlot, readonly string[]>>,
  rewrites: OrderingRewrite[],
  manifest: OrderingManifest | undefined,
  scope: "global" | "project" | undefined,
): void {
  if (manifest === undefined) {
    return;
  }

  for (const slot of Object.keys(manifest.hooks) as HookSlot[]) {
    const order = manifest.hooks[slot];
    if (order === undefined) {
      continue;
    }

    const previousOrder = perSlot[slot];
    if (scope !== undefined && previousOrder !== undefined) {
      rewrites.push({ slot, scope, previousOrder, newOrder: order });
    }
    perSlot[slot] = order;
  }
}

function validateOrderingManifest(raw: unknown, orderingJsonPath: string): OrderingManifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Validation("ordering manifest is malformed", undefined, {
      code: "OrderingManifestMalformed",
      path: orderingJsonPath,
    });
  }

  const topLevel = raw as Record<string, unknown>;
  const keys = Object.keys(topLevel);
  if (keys.some((key) => key !== "hooks")) {
    throw new Validation("ordering manifest contains unknown top-level keys", undefined, {
      code: "OrderingManifestMalformed",
      path: orderingJsonPath,
      keys,
    });
  }

  if (!Object.hasOwn(topLevel, "hooks")) {
    throw new Validation("ordering manifest is malformed", undefined, {
      code: "OrderingManifestMalformed",
      path: orderingJsonPath,
    });
  }

  const hooks = topLevel["hooks"];
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Validation("ordering manifest hooks must be an object", undefined, {
      code: "OrderingManifestMalformed",
      path: orderingJsonPath,
    });
  }

  const validatedHooks: Partial<Record<HookSlot, readonly string[]>> = {};
  for (const [slotName, value] of Object.entries(hooks as Record<string, unknown>)) {
    const slot = parseOrderingSlot(slotName, orderingJsonPath);
    if (!isStringArray(value)) {
      throw new Validation(
        "ordering manifest slot value must be a non-empty string array",
        undefined,
        {
          code: "OrderingManifestMalformed",
          path: orderingJsonPath,
          slot: slotName,
        },
      );
    }

    const order = value.slice();
    const seen = new Set<string>();
    for (const extId of order) {
      if (seen.has(extId)) {
        throw new Validation(`Duplicate extId '${extId}' in ordering manifest`, undefined, {
          code: "OrderingManifestDuplicateExtId",
          path: orderingJsonPath,
          slot: slotName,
          extId,
        });
      }
      seen.add(extId);
    }

    validatedHooks[slot] = Object.freeze(order);
  }

  return { hooks: validatedHooks };
}

function parseOrderingSlot(slotName: string, orderingJsonPath: string): HookSlot {
  const rule = RULES_BY_SLOT.get(slotName as HookSlot);
  if (rule !== undefined) {
    return rule.slot;
  }

  throw new Validation(`Unknown ordering slot '${slotName}'`, undefined, {
    code: "HookInvalidAttachment",
    path: orderingJsonPath,
    slot: slotName,
  });
}

function assertCanonicalHookMatrix(): void {
  const canonicalChecks = [
    matchesRule("SEND_REQUEST/pre", {
      rare: ["transform"],
      visibility: "full",
      firesPerCall: false,
      firesPerToken: false,
    }),
    matchesRule("STREAM_RESPONSE/pre", {
      rare: ["transform"],
      visibility: "full",
      firesPerCall: false,
      firesPerToken: true,
    }),
    matchesRule("TOOL_CALL/pre", {
      visibility: "args-only",
      firesPerCall: true,
      firesPerToken: false,
    }),
    matchesRule("TOOL_CALL/post", {
      visibility: "result",
      firesPerCall: true,
      firesPerToken: false,
    }),
    ...[
      "RECEIVE_INPUT/post",
      "COMPOSE_REQUEST/post",
      "SEND_REQUEST/post",
      "STREAM_RESPONSE/post",
      "RENDER/post",
    ].map((slot) => disallowsSubKind(slot as HookSlot, "guard")),
  ];

  if (canonicalChecks.every(Boolean)) {
    return;
  }

  throw new Validation("canonical hook taxonomy matrix is invalid", undefined, {
    code: "HookInvalidAttachment",
  });
}

function matchesRule(
  slot: HookSlot,
  expected: {
    readonly rare?: readonly HookSubKind[];
    readonly visibility: HookSlotRule["visibility"];
    readonly firesPerCall: boolean;
    readonly firesPerToken: boolean;
  },
): boolean {
  const rule = RULES_BY_SLOT.get(slot);
  if (rule === undefined) {
    return false;
  }

  return (
    rule.visibility === expected.visibility &&
    rule.firesPerCall === expected.firesPerCall &&
    rule.firesPerToken === expected.firesPerToken &&
    (expected.rare === undefined || sameSubKinds(rule.rare, expected.rare))
  );
}

function disallowsSubKind(slot: HookSlot, subKind: HookSubKind): boolean {
  const rule = RULES_BY_SLOT.get(slot);
  return rule !== undefined && !rule.allowed.includes(subKind);
}

function sameSubKinds(left: readonly HookSubKind[], right: readonly HookSubKind[]): boolean {
  return left.length === right.length && left.every((subKind, index) => subKind === right[index]);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string")
  );
}
