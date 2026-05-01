import { Cancellation, ProviderCapability, Validation } from "../../core/errors/index.js";

import { runtimeCommandCatalog } from "./command-catalog.js";
import { dispatchModelCommand, dispatchProviderCommand } from "./swap-commands.js";

import type { SessionAuditBus } from "./audit-bus.js";
import type { RuntimeContextRegistry } from "./runtime-context-registry.js";
import type { LoadedTool, ResolvedShellDeps, SessionBootstrap } from "./types.js";
import type { ProviderMessage } from "../../contracts/providers.js";
import type { SessionManifest } from "../../contracts/session-store.js";
import type { InteractionAPI } from "../../core/host/api/interaction.js";
import type { RuntimeReader } from "../../core/host/api/metrics.js";

export type RuntimeCommandOutcome = "handled" | "exit" | "not-command";

export async function handleRuntimeCommand(args: {
  readonly line: string;
  readonly session: SessionBootstrap;
  readonly tools: readonly LoadedTool[];
  readonly manifest: SessionManifest;
  readonly history: readonly ProviderMessage[];
  readonly deps: ResolvedShellDeps;
  readonly interaction: InteractionAPI;
  readonly registry: RuntimeContextRegistry;
  readonly auditBus: SessionAuditBus;
  readonly notify: (text: string) => void;
  readonly metrics?: RuntimeReader;
  readonly persist: (
    manifest: SessionManifest,
    history: readonly ProviderMessage[],
  ) => Promise<SessionManifest>;
}): Promise<RuntimeCommandOutcome> {
  if (!args.line.startsWith("/")) {
    return "not-command";
  }

  const [name, ...rest] = args.line.slice(1).trim().split(/\s+/u);
  switch (name) {
    case "help": {
      args.notify(
        runtimeCommandCatalog()
          .map(
            (entry) =>
              `${entry.name}${entry.argumentHint ? ` ${entry.argumentHint}` : ""}\t${entry.description}`,
          )
          .join("\n"),
      );
      return "handled";
    }
    case "ui":
      writeUiList(args);
      return "handled";
    case "health":
      writeHealth(args);
      return "handled";
    case "tools":
      args.notify(
        args.tools
          .map((tool) => `${tool.name}\t${tool.gated ? "gated" : "default-allowed"}`)
          .join("\n"),
      );
      return "handled";
    case "save-and-close":
      await args.persist(args.manifest, args.history);
      args.notify("session saved");
      return "exit";
    case "trust":
      args.notify("trust inspection is not wired to the CLI command surface yet");
      return "handled";
    case "reload":
      args.notify("reload is not wired to dynamic discovery yet");
      return "handled";
    case "network-policy":
      args.notify("network policy commands are not wired to this runtime yet");
      return "handled";
    case "model":
    case "provider":
      await dispatchSwap(args, name, rest[0]);
      return "handled";
    case "sm":
      args.notify(`${name} command is not wired to runtime switching yet`);
      return "handled";
    default:
      args.notify(`unknown command '/${name ?? ""}'${rest.length > 0 ? ` ${rest.join(" ")}` : ""}`);
      return "handled";
  }
}

async function dispatchSwap(
  args: {
    readonly session: SessionBootstrap;
    readonly deps: ResolvedShellDeps;
    readonly interaction: InteractionAPI;
    readonly auditBus: SessionAuditBus;
    readonly registry: RuntimeContextRegistry;
    readonly notify: (text: string) => void;
  },
  name: "model" | "provider",
  argument: string | undefined,
): Promise<void> {
  const swapArgs = {
    session: args.session,
    deps: args.deps,
    interaction: args.interaction,
    auditBus: args.auditBus,
    registry: args.registry,
    projectRoot: args.session.projectRoot,
  };
  await runSwap(args, () =>
    name === "model"
      ? dispatchModelCommand(swapArgs, argument)
      : dispatchProviderCommand(swapArgs, argument),
  );
}

function writeUiList(args: {
  readonly notify: (text: string) => void;
  readonly metrics?: RuntimeReader;
}): void {
  const snap = args.metrics?.snapshot();
  const items = snap?.ui.items ?? [];
  if (items.length === 0) {
    args.notify("no UI extensions reported (metrics.ui not yet wired by extension manager)");
    return;
  }
  args.notify(
    items
      .map((ui) => {
        const roles = ui.roles.join(",");
        const target = ui.targetUI !== undefined ? ` -> ${ui.targetUI}` : "";
        const contributions = ui.regionContributions
          ?.map((r) => `${r.region}:${r.mode}@${r.priority}`)
          .join(",");
        const tail = contributions !== undefined ? `  regions=${contributions}` : "";
        return `${ui.id}\t[${roles}]${target}${tail}`;
      })
      .join("\n"),
  );
}

function writeHealth(args: {
  readonly notify: (text: string) => void;
  readonly session: SessionBootstrap;
  readonly tools: readonly LoadedTool[];
  readonly manifest: SessionManifest;
}): void {
  const selection = args.session.selection.current();
  args.notify(
    [
      `session: ${args.session.sessionId}`,
      `provider: ${selection.entryId}`,
      `model: ${selection.modelId}`,
      `mode: ${args.session.securityMode}`,
      `projectTrust: ${args.session.projectTrusted ? "granted" : "global-only"}`,
      `sessionStore: ${args.manifest.storeId}`,
      `tools: ${args.tools.length}`,
    ].join("\n"),
  );
}

async function runSwap(
  args: {
    readonly deps: ResolvedShellDeps;
    readonly session: SessionBootstrap;
    readonly notify: (text: string) => void;
  },
  swap: () => Promise<{
    readonly kind: "swapped" | "rejected" | "noop";
    readonly selection?: { readonly entryId: string; readonly modelId: string };
    readonly reason?: { readonly code: string; readonly message: string } | string;
  }>,
): Promise<void> {
  try {
    const result = await swap();
    if (result.kind === "swapped" && result.selection !== undefined) {
      args.notify(`provider: ${result.selection.entryId}\nmodel: ${result.selection.modelId}`);
      return;
    }
    if (result.kind === "rejected" && typeof result.reason === "object") {
      args.notify(`swap rejected [${result.reason.code}]: ${result.reason.message}`);
      return;
    }
    if (result.kind === "noop" && typeof result.reason === "string") {
      args.notify(result.reason);
    }
  } catch (error) {
    if (error instanceof Cancellation) {
      args.notify("cancelled");
      return;
    }
    if (error instanceof Validation || error instanceof ProviderCapability) {
      const code = typeof error.context["code"] === "string" ? error.context["code"] : "Error";
      args.notify(`swap failed [${error.class}/${code}]: ${error.message}`);
      return;
    }
    throw error;
  }
}
