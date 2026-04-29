import { createElement, type ComponentType, type ReactNode } from "react";

export const UI_REGIONS = ["startup", "transcript", "composer", "statusLine", "dialogs"] as const;

export type UIRegion = (typeof UI_REGIONS)[number];
export type UIRegionMode = "replace" | "append" | "decorate";

export interface UIRegionViewModel {
  readonly region: UIRegion;
  readonly sessionId?: string;
  readonly providerLabel?: string;
  readonly modelId?: string;
  readonly mode?: string;
  readonly lines?: readonly string[];
  readonly statusItems?: readonly { readonly label: string; readonly value: string }[];
  readonly dialogs?: readonly { readonly kind: string; readonly prompt: string }[];
}

export interface UIRegionController {
  readonly dispatchCommand?: (commandLine: string) => Promise<void>;
  readonly submitInput?: (input: string) => Promise<void>;
}

export interface UIRegionProps {
  readonly view: UIRegionViewModel;
  readonly controller: UIRegionController;
  readonly children?: ReactNode;
}

export type UIRegionComponent = ComponentType<UIRegionProps>;

export interface UIRegionContribution {
  readonly id: string;
  readonly region: UIRegion;
  readonly mode: UIRegionMode;
  readonly priority: number;
  readonly component: UIRegionComponent;
}

export interface UIRegionRegistry {
  register(contribution: UIRegionContribution): void;
  contributions(region: UIRegion): readonly UIRegionContribution[];
  compose(region: UIRegion, props: UIRegionProps, fallback: ReactNode): ReactNode;
}

function assertRegion(region: UIRegion): void {
  if (!(UI_REGIONS as readonly string[]).includes(region)) {
    throw new Error(`unknown UI region '${region}'`);
  }
}

function sortContributions(
  contributions: readonly UIRegionContribution[],
): readonly UIRegionContribution[] {
  return [...contributions].sort(
    (left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
  );
}

export function createUIRegionRegistry(): UIRegionRegistry {
  const byRegion = new Map<UIRegion, UIRegionContribution[]>();

  return {
    register(contribution): void {
      assertRegion(contribution.region);
      const current = byRegion.get(contribution.region) ?? [];
      const withoutSameId = current.filter((item) => item.id !== contribution.id);
      byRegion.set(contribution.region, [...withoutSameId, contribution]);
    },

    contributions(region): readonly UIRegionContribution[] {
      assertRegion(region);
      return sortContributions(byRegion.get(region) ?? []);
    },

    compose(region, props, fallback): ReactNode {
      const contributions = this.contributions(region);
      const replacement = contributions.find((item) => item.mode === "replace");
      const node =
        replacement !== undefined
          ? createElement(replacement.component, props)
          : contributions
              .filter((item) => item.mode === "decorate")
              .reverse()
              .reduce<ReactNode>(
                (child, item) => createElement(item.component, { ...props, children: child }),
                fallback,
              );

      const appended = contributions.filter((item) => item.mode === "append");
      if (appended.length === 0) {
        return node;
      }

      return [
        node,
        ...appended.map((item) => createElement(item.component, { ...props, key: item.id })),
      ];
    },
  };
}
