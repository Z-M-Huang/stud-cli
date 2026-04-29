import { Box, Static, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";

import {
  ApprovalDialog,
  ApprovalDialogClearance,
  type ApprovalDialogView,
} from "./approval-dialog.js";

import type { StatusLineItem } from "./status-line.js";
import type { Theme } from "./theme.js";
import type { ProviderMessage, ProviderContentPart } from "../../../contracts/providers.js";
import type { SecurityMode } from "../../../contracts/settings-shape.js";

export interface ToolCardView {
  readonly id: string;
  readonly name: string;
  readonly status: "running" | "completed" | "failed";
  readonly summary?: string | undefined;
}

export type TranscriptItem =
  | { readonly kind: "header"; readonly id: string; readonly header: HeaderInfo }
  | { readonly kind: "startup"; readonly id: string; readonly startup: StartupInfo }
  | {
      readonly kind: "message";
      readonly id: string;
      readonly message: ProviderMessage;
      readonly timestamp?: string | undefined;
    }
  | { readonly kind: "tool"; readonly id: string; readonly card: ToolCardView }
  | { readonly kind: "thinking"; readonly id: string }
  | { readonly kind: "error"; readonly id: string; readonly message: string };

export interface HeaderInfo {
  readonly version: string;
  readonly tagline: string;
  readonly sessionId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly mode: SecurityMode;
  readonly online: boolean;
}

export interface StartupInfo {
  readonly header: string;
  readonly details: readonly string[];
}

export interface PaletteEntry {
  readonly name: `/${string}`;
  readonly description: string;
  readonly category?: string | undefined;
}

export interface InkTUIFrameProps {
  readonly transcriptItems: readonly TranscriptItem[];
  readonly assistantDraft?: string | undefined;
  readonly composerText: string;
  readonly composerHint: string;
  readonly palette?: readonly PaletteEntry[] | undefined;
  readonly paletteSelectedIndex?: number | undefined;
  readonly approvalDialog?: ApprovalDialogView | undefined;
  readonly approvalClearance?: boolean | undefined;
  readonly statusItems: readonly StatusLineItem[];
  readonly theme?: Theme | undefined;
  readonly onComposerKey: (input: string, key: ComposerKey) => void;
}

const SUBMIT_HINT = "Ask anything... (Enter to send, Ctrl+K to toggle)";
export const DEFAULT_INK_FRAME_HINT: string = SUBMIT_HINT;

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

function statusToneToColor(
  tone: StatusLineItem["tone"],
  theme: Theme | undefined,
): string | undefined {
  switch (tone) {
    case "good":
      return theme?.accent;
    case "warn":
      return theme?.warn;
    case "bad":
      return theme?.bad;
    case "accent":
      return theme?.info;
    case "muted":
      return theme?.muted;
    case "normal":
    case undefined:
    default:
      return theme?.text;
  }
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

function MessageCard({
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

function AssistantDraft({
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

function ThinkingRow({ theme }: { readonly theme?: Theme | undefined }): React.ReactElement {
  return (
    <Box marginBottom={1}>
      <Text {...c(theme?.muted)}>▸ Thinking (collapsed)</Text>
    </Box>
  );
}

function ToolCard({
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
        : theme?.warn;
  const badgeLabel =
    card.status === "completed"
      ? "✓ completed"
      : card.status === "failed"
        ? "✗ failed"
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
      {card.summary !== undefined && card.summary.length > 0 ? (
        <Text {...c(theme?.muted)}>{card.summary}</Text>
      ) : null}
    </Box>
  );
}

function ErrorBlock({
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

function Header(props: {
  readonly info: HeaderInfo;
  readonly theme?: Theme | undefined;
}): React.ReactElement {
  const dotColor = props.info.online ? props.theme?.accent : props.theme?.bad;
  // Single Text row with inline-colored spans. The header is rendered through
  // <Static> at the top of output (printed once at mount). Avoids flex-wrap
  // surprises that split "stud-cli v0.6.0" across two lines on a real terminal.
  return (
    <Text wrap="truncate-end">
      <Text {...c(props.theme?.accent)} bold>
        ▍S{" "}
      </Text>
      <Text {...c(props.theme?.accent)} bold>
        stud-cli {props.info.version}
      </Text>
      <Text {...c(props.theme?.muted)}>
        {"  "}
        {props.info.tagline}
      </Text>
      <Text {...c(props.theme?.muted)}>{"     Session: "}</Text>
      <Text {...c(props.theme?.text)}>{props.info.sessionId}</Text>
      <Text {...c(props.theme?.muted)}>{"   Model: "}</Text>
      <Text {...c(props.theme?.text)}>
        {props.info.providerLabel}:{props.info.modelId}
      </Text>
      <Text {...c(props.theme?.muted)}>{"   Mode: "}</Text>
      <Text {...c(props.theme?.text)}>{props.info.mode.toUpperCase()}</Text>
      <Text {...c(props.theme?.muted)}>{"   "}</Text>
      <Text {...c(dotColor)}>●</Text>
      <Text {...c(props.theme?.text)}> {props.info.online ? "Online" : "Offline"}</Text>
    </Text>
  );
}

/** Block-letter "S" — five rows tall, used as the startup-card logo glyph. */
const S_LOGO_LINES: readonly string[] = ["▄▄▄▄▄", "█    ", "▀▀▀▀▄", "    █", "▀▀▀▀▀"];

function StartupCard(props: {
  readonly info: StartupInfo;
  readonly theme?: Theme | undefined;
}): React.ReactElement {
  return (
    <Box borderStyle="round" {...b(props.theme?.border)} paddingX={2} paddingY={1} marginY={1}>
      <Box flexDirection="column" marginRight={2}>
        {S_LOGO_LINES.map((line, idx) => (
          <Text key={`s-l-${idx.toString()}`} {...c(props.theme?.accent)} bold>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text {...c(props.theme?.text)} bold>
          {props.info.header}
        </Text>
        {props.info.details.map((line, idx) => (
          <Text key={`s-d-${idx.toString()}`} {...c(props.theme?.muted)}>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function SlashPalette(props: {
  readonly entries: readonly PaletteEntry[];
  readonly selectedIndex?: number | undefined;
  readonly theme?: Theme | undefined;
}): React.ReactElement | null {
  if (props.entries.length === 0) {
    return null;
  }
  const selected = props.selectedIndex ?? 0;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...b(props.theme?.border)}
      paddingX={1}
      marginBottom={1}
    >
      {props.entries.slice(0, 8).map((entry, idx) => {
        const isSelected = idx === selected;
        const arrow = isSelected ? "❯ " : "  ";
        const nameColor = isSelected ? props.theme?.accent : props.theme?.info;
        const descColor = isSelected ? props.theme?.text : props.theme?.muted;
        return (
          <Box key={entry.name} justifyContent="space-between">
            <Text {...c(nameColor)} bold={isSelected}>
              {arrow}
              {entry.name}
            </Text>
            <Text {...c(descColor)}>{entry.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export interface ComposerKey {
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly escape?: boolean;
  readonly tab?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
}

function Composer(props: {
  readonly value: string;
  readonly hint: string;
  readonly theme?: Theme | undefined;
  /** Called for every keypress chunk. The mount owns buffer state. */
  readonly onKey: (input: string, key: ComposerKey) => void;
}): React.ReactElement {
  useInput((input, key) => {
    props.onKey(input, key);
  });
  return (
    <Box borderStyle="round" {...b(props.theme?.border)} paddingX={1}>
      <Text {...c(props.theme?.muted)}>{"> "}</Text>
      <Text {...c(props.theme?.text)}>{props.value.length === 0 ? props.hint : props.value}</Text>
    </Box>
  );
}

function StatusLineRow(props: {
  readonly items: readonly StatusLineItem[];
  readonly theme?: Theme | undefined;
}): React.ReactElement {
  return (
    <Box>
      {props.items.map((item, idx) => (
        <Box key={item.id}>
          {idx > 0 ? <Text {...c(props.theme?.muted)}>{"   "}</Text> : null}
          <Text {...c(props.theme?.muted)}>
            {item.label}
            {item.label.length > 0 ? " " : ""}
          </Text>
          <Text {...c(statusToneToColor(item.tone, props.theme))}>{item.value}</Text>
        </Box>
      ))}
    </Box>
  );
}

function renderTranscriptItem(
  item: TranscriptItem,
  theme: Theme | undefined,
): React.ReactElement | null {
  switch (item.kind) {
    case "header":
      return <Header info={item.header} theme={theme} />;
    case "startup":
      return <StartupCard info={item.startup} theme={theme} />;
    case "message":
      return (
        <MessageCard
          itemId={item.id}
          message={item.message}
          theme={theme}
          timestamp={item.timestamp}
        />
      );
    case "tool":
      return <ToolCard card={item.card} theme={theme} />;
    case "thinking":
      return <ThinkingRow theme={theme} />;
    case "error":
      return <ErrorBlock message={item.message} theme={theme} />;
  }
}

export function InkTUIFrame(props: InkTUIFrameProps): React.ReactElement {
  return (
    <>
      <Static items={props.transcriptItems as TranscriptItem[]}>
        {(item: TranscriptItem) => (
          <Box
            key={item.id}
            flexDirection="column"
            paddingX={1}
            width={process.stdout.columns ?? 80}
          >
            {renderTranscriptItem(item, props.theme)}
          </Box>
        )}
      </Static>

      <Box flexDirection="column" paddingX={1} width={process.stdout.columns ?? 80}>
        <AssistantDraft draft={props.assistantDraft ?? ""} theme={props.theme} />

        <Box flexDirection="column">
          {props.approvalDialog !== undefined ? (
            <ApprovalDialog dialog={props.approvalDialog} theme={props.theme} />
          ) : props.approvalClearance === true ? (
            <ApprovalDialogClearance />
          ) : null}
        </Box>

        {/* Always render a palette slot; empty when no palette is open. Stable
            tree shape avoids the Ink Static + log-update orphan-row symptom. */}
        <Box flexDirection="column">
          {props.palette !== undefined ? (
            <SlashPalette
              entries={props.palette}
              selectedIndex={props.paletteSelectedIndex}
              theme={props.theme}
            />
          ) : null}
        </Box>

        <Composer
          value={props.composerText}
          hint={props.composerHint}
          theme={props.theme}
          onKey={props.onComposerKey}
        />

        <Box marginTop={1}>
          <StatusLineRow items={props.statusItems} theme={props.theme} />
        </Box>
      </Box>
    </>
  );
}

export { useEffect, useState };
