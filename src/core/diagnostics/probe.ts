import { Session } from "../errors/session.js";
import { getRegisteredServers } from "../mcp/server-registry.js";
import { listTrusted } from "../mcp/trust.js";

import { snapshotReport as renderSnapshotReport } from "./report.js";

export interface HealthReport {
  readonly extensions: readonly {
    readonly id: string;
    readonly kind: string;
    readonly state: "loaded" | "disabled" | "degraded";
  }[];
  readonly activeStore: string;
  readonly activeInteractor: string;
  readonly mode: "ask" | "yolo" | "allowlist";
  readonly sm?: {
    readonly smId: string;
    readonly currentStageId: string;
    readonly depth: number;
  };
  readonly mcp: readonly {
    readonly server: string;
    readonly trusted: boolean;
    readonly healthy: boolean;
  }[];
  readonly loop: {
    readonly turnCount: number;
    readonly lastCorrelationId: string | undefined;
  };
}

interface ExtensionSnapshot {
  readonly id: string;
  readonly kind: string;
  readonly state: "loaded" | "disabled" | "degraded";
}

interface SMRuntimeSnapshot {
  readonly smId: string;
  readonly currentStageId: string;
  readonly depth: number;
}

interface LoopSnapshot {
  readonly turnCount: number;
  readonly lastCorrelationId: string | undefined;
}

interface DiagnosticsState {
  initialized: boolean;
  activeStore: string;
  activeInteractor: string;
  mode: "ask" | "yolo" | "allowlist";
  extensions: readonly ExtensionSnapshot[];
  sm: SMRuntimeSnapshot | undefined;
  loop: LoopSnapshot;
  readonly mcpHealthByServer: Map<string, boolean>;
}

const state: DiagnosticsState = {
  initialized: false,
  activeStore: "",
  activeInteractor: "",
  mode: "ask",
  extensions: [],
  sm: undefined,
  loop: { turnCount: 0, lastCorrelationId: undefined },
  mcpHealthByServer: new Map<string, boolean>(),
};

function sortedExtensions(): readonly HealthReport["extensions"][number][] {
  return Object.freeze(
    [...state.extensions]
      .map((extension) => Object.freeze({ ...extension }))
      .sort(
        (left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind),
      ),
  );
}

function snapshotSM():
  | {
      readonly smId: string;
      readonly currentStageId: string;
      readonly depth: number;
    }
  | undefined {
  if (state.sm === undefined) {
    return undefined;
  }

  return Object.freeze({ ...state.sm });
}

async function snapshotMCP(): Promise<readonly HealthReport["mcp"][number][]> {
  const trustedEntries = await listTrusted();
  const trustedServerIds = new Set<string>(trustedEntries.map((entry) => entry.serverId));

  return Object.freeze(
    getRegisteredServers()
      .map((server) =>
        Object.freeze({
          server: server.id,
          trusted: server.scope === "bundled" || trustedServerIds.has(server.id),
          healthy: state.mcpHealthByServer.get(server.id) ?? false,
        }),
      )
      .sort((left, right) => left.server.localeCompare(right.server)),
  );
}

function assertInitialized(): void {
  if (state.initialized) {
    return;
  }

  throw new Session("session registries are not initialized", undefined, {
    code: "StateUnavailable",
  });
}

export async function probe(): Promise<HealthReport> {
  assertInitialized();

  const report: HealthReport = {
    extensions: sortedExtensions(),
    activeStore: state.activeStore,
    activeInteractor: state.activeInteractor,
    mode: state.mode,
    mcp: await snapshotMCP(),
    loop: Object.freeze({ ...state.loop }),
  };

  const sm = snapshotSM();
  if (sm !== undefined) {
    return Object.freeze({ ...report, sm });
  }

  return Object.freeze(report);
}

export function snapshotReport(report: HealthReport): string {
  return renderSnapshotReport(report);
}

export function __initializeDiagnosticsForTest(input: {
  readonly activeStore: string;
  readonly activeInteractor: string;
  readonly mode: "ask" | "yolo" | "allowlist";
  readonly extensions?: readonly ExtensionSnapshot[];
}): void {
  state.initialized = true;
  state.activeStore = input.activeStore;
  state.activeInteractor = input.activeInteractor;
  state.mode = input.mode;
  state.extensions = Object.freeze(
    [...(input.extensions ?? [])]
      .map((extension) => Object.freeze({ ...extension }))
      .sort(
        (left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind),
      ),
  );
}

export function __resetDiagnosticsForTest(): void {
  state.initialized = false;
  state.activeStore = "";
  state.activeInteractor = "";
  state.mode = "ask";
  state.extensions = [];
  state.sm = undefined;
  state.loop = { turnCount: 0, lastCorrelationId: undefined };
  state.mcpHealthByServer.clear();
}

export function __primeMCPHistoryForTest(
  history: readonly { readonly server: string; readonly connected: boolean }[],
): void {
  state.mcpHealthByServer.clear();
  for (const entry of history) {
    state.mcpHealthByServer.set(entry.server, entry.connected);
  }
}

export function __detachSMForTest(): void {
  state.sm = undefined;
}

export function __attachSMForTest(input: SMRuntimeSnapshot): void {
  state.sm = Object.freeze({ ...input });
}

export function __setLoopSnapshotForTest(input: LoopSnapshot): void {
  state.loop = Object.freeze({ ...input });
}
