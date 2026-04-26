import type { HookSlot } from "./taxonomy.js";

export interface OrderingManifest {
  readonly hooks: Readonly<Partial<Record<HookSlot, readonly string[]>>>;
}

export interface OrderingManifestByScope {
  readonly bundled: OrderingManifest | undefined;
  readonly global: OrderingManifest | undefined;
  readonly project: OrderingManifest | undefined;
}

export interface OrderingRewrite {
  readonly slot: HookSlot;
  readonly scope: "global" | "project";
  readonly previousOrder: readonly string[];
  readonly newOrder: readonly string[];
}

export interface MergedOrdering {
  readonly perSlot: Readonly<Partial<Record<HookSlot, readonly string[]>>>;
  readonly rewrites: readonly OrderingRewrite[];
}
