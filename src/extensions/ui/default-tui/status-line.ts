import { spawn } from "node:child_process";

import type { SecurityMode } from "../../../contracts/settings-shape.js";
import type { RuntimeSnapshot } from "../../../core/host/api/metrics.js";

export type StatusTone = "normal" | "muted" | "good" | "warn" | "bad" | "accent";

export interface StatusLineItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly tone?: StatusTone;
}

/**
 * Inputs to the bundled status-line widgets.
 *
 * Provider/model/mode are intentionally absent from the default widget set —
 * the spec places them in the compact header. They remain in this context
 * type so plugin widgets can reach them, but `defaultStatusLineItems` does
 * not surface them.
 *
 * Wiki: reference-extensions/ui/Default-TUI.md § Status line
 */
export interface StatusLineContext {
  readonly sessionId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly mode: SecurityMode;
  readonly cwd: string;
  readonly projectTrust: "granted" | "global-only";
  readonly gitBranch?: string | undefined;
  readonly contextPercent?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly toolsActive?: number | undefined;
  readonly toolsTotal?: number | undefined;
  readonly mcpConnected?: number | undefined;
  readonly mcpTotal?: number | undefined;
  readonly diagnostics?: number | undefined;
  readonly activeStateMachine?: string | undefined;
  readonly sessionStartedAt?: Date | undefined;
  readonly now?: Date | undefined;
}

export interface CommandStatusWidgetConfig {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly shell?: boolean;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CommandStatusWidgetResult {
  readonly ok: boolean;
  readonly item: StatusLineItem;
  readonly stderr?: string;
  readonly timedOut?: boolean;
}

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200;

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function durationLabel(start: Date | undefined, now: Date | undefined): string {
  if (start === undefined || now === undefined) {
    return "--:--:--";
  }
  const seconds = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000));
  const hh = Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0");
  const mm = Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function tokenLabel(value: number | undefined): string {
  if (value === undefined) return "--";
  if (value < 1_000) return value.toString();
  if (value < 100_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value / 1_000)}k`;
}

function ratio(numerator: number | undefined, denominator: number | undefined): string {
  if (numerator === undefined || denominator === undefined) {
    return "--";
  }
  return `${numerator}/${denominator}`;
}

function trimOutput(value: string, maxBytes: number): string {
  const normalized = value.replace(/\r/gu, "").trim().replace(/\s+/gu, " ");
  const bytes = Buffer.byteLength(normalized);
  if (bytes <= maxBytes) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxBytes - 12)).trimEnd()}...`;
}

/**
 * The bundled status-line widget set, aligned with
 * `reference-extensions/ui/Default-TUI.md § Status line`. Provider/model/mode
 * are intentionally omitted (header territory). `diag` only renders when
 * non-zero. Plugins can append their own widgets via the region registry.
 */
export function defaultStatusLineItems(context: StatusLineContext): readonly StatusLineItem[] {
  const items: StatusLineItem[] = [
    {
      id: "git",
      label: "*",
      value: context.gitBranch ?? "--",
      tone: context.gitBranch === undefined ? "muted" : "good",
    },
    {
      id: "context",
      label: "Context",
      value:
        context.contextPercent === undefined ? "--" : `${clampPercent(context.contextPercent)}%`,
      tone:
        context.contextPercent === undefined
          ? "muted"
          : context.contextPercent >= 85
            ? "warn"
            : "accent",
    },
    {
      id: "input",
      label: "Input",
      value: tokenLabel(context.inputTokens),
      tone: context.inputTokens === undefined ? "muted" : "normal",
    },
    {
      id: "output",
      label: "Output",
      value: tokenLabel(context.outputTokens),
      tone: context.outputTokens === undefined ? "muted" : "normal",
    },
    {
      id: "tools",
      label: "Tools",
      value: ratio(context.toolsActive, context.toolsTotal),
      tone: context.toolsTotal === undefined ? "muted" : "normal",
    },
    {
      id: "mcp",
      label: "MCP",
      value: ratio(context.mcpConnected, context.mcpTotal),
      tone:
        context.mcpTotal === undefined
          ? "muted"
          : context.mcpConnected !== undefined && context.mcpConnected < context.mcpTotal
            ? "warn"
            : "normal",
    },
    {
      id: "elapsed",
      label: "",
      value: durationLabel(context.sessionStartedAt, context.now),
      tone: "muted",
    },
  ];
  if (context.diagnostics !== undefined && context.diagnostics > 0) {
    items.splice(items.length - 1, 0, {
      id: "diag",
      label: "Diag",
      value: String(context.diagnostics),
      tone: "warn",
    });
  }
  return items;
}

/**
 * Build a `StatusLineContext` from a public `RuntimeSnapshot` so plugin and
 * bundled widgets share one data path. Optional augmentations (git branch,
 * elapsed) are layered on top.
 */
export function statusContextFromRuntime(
  snap: RuntimeSnapshot,
  extras: {
    readonly gitBranch?: string;
    readonly now?: Date;
  } = {},
): StatusLineContext {
  return {
    sessionId: snap.session.id,
    providerLabel: snap.provider.current.label,
    modelId: snap.provider.current.modelId,
    mode: snap.session.mode,
    cwd: snap.session.cwd,
    projectTrust: snap.session.projectTrust,
    gitBranch: extras.gitBranch,
    contextPercent: snap.context.percent,
    inputTokens: snap.tokens.inputTotal,
    outputTokens: snap.tokens.outputTotal,
    toolsActive: snap.tools.activeCount,
    toolsTotal: snap.tools.totalCount,
    mcpConnected: snap.mcp.connectedCount,
    mcpTotal: snap.mcp.configuredCount,
    diagnostics: snap.diagnostics.errorCount,
    activeStateMachine: snap.stateMachine?.id,
    sessionStartedAt: new Date(snap.session.startedAt),
    now: extras.now,
  };
}

export function renderStatusLine(items: readonly StatusLineItem[]): string {
  return items.map((item) => `${item.label} ${item.value}`).join(" | ");
}

export function resolveCommandStatusWidget(
  config: CommandStatusWidgetConfig,
): Promise<CommandStatusWidgetResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    const child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: config.env,
      shell: config.shell === true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      child.kill("SIGTERM");
      resolve({
        ok: false,
        timedOut: true,
        item: { id: config.id, label: config.label, value: "stale", tone: "warn" },
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stderr: error.message,
        item: { id: config.id, label: config.label, value: "error", tone: "bad" },
      });
    });
    child.on("close", (code) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({
          ok: true,
          item: {
            id: config.id,
            label: config.label,
            value: trimOutput(stdout, maxOutputBytes),
            tone: "normal",
          },
          stderr: trimOutput(stderr, maxOutputBytes),
        });
        return;
      }
      resolve({
        ok: false,
        stderr: trimOutput(stderr, maxOutputBytes),
        item: { id: config.id, label: config.label, value: "error", tone: "bad" },
      });
    });
  });
}
