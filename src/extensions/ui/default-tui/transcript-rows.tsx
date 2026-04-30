import { Box, Text } from "ink";
import React from "react";

import type { ToolCardView } from "./ink-app.js";
import type { Theme } from "./theme.js";
import type { ProviderContentPart, ProviderMessage } from "../../../contracts/providers.js";

/**
 * Optional-color helpers — Ink's `color`/`borderColor` props don't accept
 * `undefined` under `exactOptionalPropertyTypes`. These spread either the
 * resolved value or nothing, letting the terminal default fall through.
 */
function c(color: string | undefined): { readonly color?: string } {
  return color === undefined ? {} : { color };
}
function b(color: string | undefined): { readonly borderColor?: string } {
  return color === undefined ? {} : { borderColor: color };
}

function partsAsLines(content: ProviderMessage["content"]): readonly string[] {
  if (typeof content === "string") {
    return content.split(/\r?\n/u);
  }
  return content.flatMap((part: ProviderContentPart): readonly string[] => {
    switch (part.type) {
      case "text":
        return part.text.split(/\r?\n/u);
      case "tool-call":
        return [`[tool] ${part.toolName}`];
      case "tool-result":
        return [`[${part.toolName}] ${part.content}`.split(/\r?\n/u).join(" ")];
      case "image":
        return [`[image] ${part.url}`];
    }
  });
}

function roleLabel(role: ProviderMessage["role"]): string {
  if (role === "user") return "you";
  if (role === "tool") return "tool";
  return "stud-cli";
}

function roleColor(role: ProviderMessage["role"], theme: Theme | undefined): string | undefined {
  if (role === "user") return theme?.info;
  if (role === "tool") return theme?.muted;
  return theme?.accent;
}

export function MessageCard({
  message,
  theme,
  itemId,
  timestamp,
}: {
  readonly message: ProviderMessage;
  readonly theme?: Theme | undefined;
  readonly itemId: string;
  readonly timestamp?: string | undefined;
}): React.ReactElement {
  const lines = partsAsLines(message.content);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text {...c(roleColor(message.role, theme))} bold>
          {roleLabel(message.role)}
        </Text>
        {timestamp !== undefined ? (
          <Text {...c(theme?.muted)}>
            {"  "}
            {timestamp}
          </Text>
        ) : null}
      </Text>
      {lines.map((line, idx) => (
        <Text key={`${itemId}-l-${idx.toString()}`} {...c(theme?.text)}>
          {line.length === 0 ? " " : line}
        </Text>
      ))}
    </Box>
  );
}

export function AssistantDraft({
  draft,
  theme,
}: {
  readonly draft: string;
  readonly theme?: Theme | undefined;
}): React.ReactElement {
  // Always render a Box (empty when no draft) instead of returning null. This
  // keeps the React tree shape constant across renders so Ink's reconciler +
  // log-update don't drop a leading row when transcript items are appended.
  if (draft.length === 0) {
    return <Box flexDirection="column" />;
  }
  const lines = draft.split(/\r?\n/u);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text {...c(theme?.accent)} bold>
        stud-cli
      </Text>
      {lines.map((line, idx) => (
        <Text key={`d-${idx.toString()}`} {...c(theme?.text)}>
          {line.length === 0 ? " " : line}
        </Text>
      ))}
    </Box>
  );
}

export function ThinkingRow({
  text,
  theme,
}: {
  readonly text: string;
  readonly theme?: Theme | undefined;
}): React.ReactElement {
  const lines = text.split(/\r?\n/u);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text {...c(theme?.thinking)} dimColor bold>
        stud-cli[thinking]
      </Text>
      {lines.map((line, idx) => (
        <Text key={`th-${idx.toString()}`} {...c(theme?.thinking)} dimColor>
          {line.length === 0 ? " " : line}
        </Text>
      ))}
    </Box>
  );
}

export function ToolCard({
  card,
  theme,
}: {
  readonly card: ToolCardView;
  readonly theme?: Theme | undefined;
}): React.ReactElement {
  const badgeColor =
    card.status === "completed"
      ? theme?.accent
      : card.status === "failed"
        ? theme?.bad
        : card.status === "cancelled"
          ? theme?.muted
          : theme?.warn;
  const badgeLabel =
    card.status === "completed"
      ? "✓ completed"
      : card.status === "failed"
        ? "✗ failed"
        : card.status === "cancelled"
          ? "⊘ cancelled"
          : "… running";
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...b(theme?.border)}
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Text {...c(theme?.info)}>Tool: {card.name}</Text>
        <Text {...c(badgeColor)}>{badgeLabel}</Text>
      </Box>
      {card.args !== undefined && card.args.length > 0 ? (
        <Text {...c(theme?.muted)}>{card.args}</Text>
      ) : null}
      {card.summary !== undefined && card.summary.length > 0 ? (
        <Text {...c(theme?.muted)}>{card.summary}</Text>
      ) : null}
    </Box>
  );
}

export function ErrorBlock({
  message,
  theme,
}: {
  readonly message: string;
  readonly theme?: Theme | undefined;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text {...c(theme?.bad)} bold>
        error
      </Text>
      <Text {...c(theme?.text)}>{message}</Text>
    </Box>
  );
}
