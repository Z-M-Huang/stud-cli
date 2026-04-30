import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Text } from "ink";

import { ThinkingRow } from "../../../../src/extensions/ui/default-tui/transcript-rows.js";

import type { Theme } from "../../../../src/extensions/ui/default-tui/theme.js";

interface ReactElementShape {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

function flattenChildren(value: unknown): readonly ReactElementShape[] {
  if (value === undefined || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(flattenChildren);
  if ("type" in value) return [value as ReactElementShape];
  return [];
}

function children(element: ReactElementShape): readonly ReactElementShape[] {
  return flattenChildren(element.props["children"]);
}

function flatten(element: ReactElementShape): readonly ReactElementShape[] {
  return [element, ...children(element).flatMap(flatten)];
}

function textNodes(element: ReactElementShape): readonly ReactElementShape[] {
  return flatten(element).filter((node) => node.type === Text);
}

const THEME: Theme = {
  text: "#E8DCC4",
  muted: "#6C7280",
  thinking: "#9095A0",
  accent: "#7FBA72",
  info: "#4FC3DC",
  warn: "#E0B040",
  bad: "#E85A4F",
  surface: "#0A0E1A",
  border: "#2A3142",
};

describe("default-tui ThinkingRow", () => {
  it("renders the thinking color when a theme is provided", () => {
    const element = ThinkingRow({ text: "thinking out loud", theme: THEME }) as ReactElementShape;
    const texts = textNodes(element);
    assert.ok(texts.length >= 2);
    for (const text of texts) {
      assert.equal(text.props["color"], THEME.thinking);
      assert.equal(text.props["dimColor"], true);
    }
  });

  it("falls back to the terminal default when theme is undefined (NO_COLOR)", () => {
    const element = ThinkingRow({ text: "thinking out loud" }) as ReactElementShape;
    const texts = textNodes(element);
    assert.ok(texts.length >= 2);
    for (const text of texts) {
      // No `color` prop is set when the theme is suppressed; the helper
      // returns an empty object so Ink renders with the terminal default.
      assert.equal("color" in text.props, false);
      // dimColor stays so the block remains visually distinct under NO_COLOR.
      assert.equal(text.props["dimColor"], true);
    }
  });

  it("never reads from theme.muted (the previous, too-dark token)", () => {
    const element = ThinkingRow({ text: "x", theme: THEME }) as ReactElementShape;
    const texts = textNodes(element);
    for (const text of texts) {
      assert.notEqual(text.props["color"], THEME.muted);
    }
  });
});
