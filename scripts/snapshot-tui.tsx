#!/usr/bin/env -S node --import tsx
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-empty-function, no-control-regex */
/**
 * Snapshot the Concept C frame (live conversation state) to stdout.
 * Useful for non-TTY visual inspection.
 */
import { Readable, Writable } from "node:stream";

import { render } from "ink";
import React from "react";

import {
  InkTUIFrame,
  type PaletteEntry,
  type TranscriptItem,
} from "../src/extensions/ui/default-tui/ink-app.js";
import { defaultStatusLineItems } from "../src/extensions/ui/default-tui/status-line.js";
import { defaultTheme } from "../src/extensions/ui/default-tui/theme.js";

let captured = "";
const sink = new Writable({
  write(chunk, _enc, cb) {
    captured += chunk.toString("utf8");
    cb();
  },
}) as unknown as NodeJS.WriteStream;
(sink as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 110;
(sink as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 32;
(sink as unknown as { isTTY: boolean }).isTTY = true;

const fakeStdin = Object.assign(new Readable({ read() {} }), {
  isTTY: true,
  setRawMode: () => fakeStdin,
  ref: () => fakeStdin,
  unref: () => fakeStdin,
  resume: () => fakeStdin,
  pause: () => fakeStdin,
  setEncoding: () => fakeStdin,
}) as unknown as NodeJS.ReadStream;

const startedAt = new Date(Date.now() - 12 * 60 * 1000 - 34 * 1000);

const palette: readonly PaletteEntry[] = [
  { name: "/plan", description: "Create a step-by-step plan" },
  { name: "/explain", description: "Explain selected code" },
  { name: "/find", description: "Find files or symbols" },
  { name: "/tests", description: "Generate tests" },
  { name: "/fix", description: "Attempt to fix issues" },
  { name: "/help", description: "Show all commands" },
];

const statusItems = defaultStatusLineItems({
  sessionId: "repo-refactor",
  providerLabel: "openai-compatible",
  modelId: "gpt-5o",
  mode: "ask",
  cwd: "/app/stud-cli",
  projectTrust: "granted",
  gitBranch: "main",
  contextPercent: 62,
  inputTokens: 18_400,
  outputTokens: 2_100,
  toolsActive: 2,
  toolsTotal: 4,
  mcpConnected: 2,
  mcpTotal: 3,
  sessionStartedAt: startedAt,
  now: new Date(),
});

const transcriptItems: readonly TranscriptItem[] = [
  {
    kind: "header",
    id: "header",
    header: {
      version: "v0.6.0",
      tagline: "an coding assistant",
      sessionId: "repo-refactor",
      providerLabel: "openai-compatible",
      modelId: "gpt-5o",
      mode: "ask",
      online: true,
    },
  },
  {
    kind: "message",
    id: "m-1",
    message: { role: "user", content: "How do I add rate limiting to my Express API?" },
    timestamp: "14:31:48",
  },
  {
    kind: "message",
    id: "m-2",
    message: {
      role: "assistant",
      content: "I'll help you add rate limiting to your Express API using express-rate-limit:",
    },
    timestamp: "14:31:55",
  },
  {
    kind: "thinking",
    id: "th-1",
    text: "Looking at the current Express setup, the right middleware to use is express-rate-limit; need to check if it's already a dep, then mount it on the public routes only.",
  },
  {
    kind: "tool",
    id: "t-1",
    card: {
      id: "read_file",
      toolCallId: "tc-snapshot-1",
      name: "read_file",
      status: "completed",
      summary: "path: src/server.ts\nlines: 1-120\n\n120 lines",
    },
  },
];

const instance = render(
  <InkTUIFrame
    transcriptItems={transcriptItems}
    runningToolCards={[]}
    composerText="/"
    composerHint="Ask anything... (Enter to send, Ctrl+K to toggle)"
    palette={palette}
    statusItems={statusItems}
    theme={defaultTheme(sink)}
    onComposerKey={() => undefined}
  />,
  { stdout: sink, stdin: fakeStdin, patchConsole: false, exitOnCtrlC: false },
);

setTimeout(() => {
  instance.unmount();
  const stripped = captured.replace(/\x1b\[[?0-9;]*[a-z]/gi, "");
  process.stdout.write("=== STRIPPED ===\n");
  process.stdout.write(stripped);
  process.stdout.write("\n=== END ===\n");
}, 50);
