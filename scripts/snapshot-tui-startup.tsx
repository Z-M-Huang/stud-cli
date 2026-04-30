#!/usr/bin/env -S node --import tsx
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-empty-function, no-control-regex */
/** Snapshot the empty-startup state of the Concept C frame. */
import { Readable, Writable } from "node:stream";

import { render } from "ink";
import React from "react";

import { InkTUIFrame, type TranscriptItem } from "../src/extensions/ui/default-tui/ink-app.js";
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

const startedAt = new Date(Date.now());

const statusItems = defaultStatusLineItems({
  sessionId: "repo-refactor",
  providerLabel: "openai-compatible",
  modelId: "gpt-5o",
  mode: "ask",
  cwd: "/app/stud-cli",
  projectTrust: "granted",
  gitBranch: "main",
  contextPercent: 0,
  inputTokens: 0,
  outputTokens: 0,
  toolsActive: 4,
  toolsTotal: 4,
  mcpConnected: 0,
  mcpTotal: 0,
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
    kind: "startup",
    id: "startup",
    startup: {
      header: "stud-cli",
      details: ["Type /help for commands", "● Loading context..."],
    },
  },
];

const instance = render(
  <InkTUIFrame
    transcriptItems={transcriptItems}
    runningToolCards={[]}
    composerText=""
    composerHint="Ask anything... (Enter to send, Ctrl+K to toggle)"
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
