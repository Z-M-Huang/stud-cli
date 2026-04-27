import type { LoadedTool, ResolvedShellDeps, SessionBootstrap } from "./types.js";
import type { ProviderMessage } from "../../contracts/providers.js";
import type { SessionManifest } from "../../contracts/session-store.js";

export type RuntimeCommandOutcome = "handled" | "exit" | "not-command";

export async function handleRuntimeCommand(args: {
  readonly line: string;
  readonly session: SessionBootstrap;
  readonly tools: readonly LoadedTool[];
  readonly manifest: SessionManifest;
  readonly history: readonly ProviderMessage[];
  readonly deps: ResolvedShellDeps;
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
    case "health":
      args.deps.stdout.write(
        [
          `session: ${args.session.sessionId}`,
          `provider: ${args.session.provider.providerId}`,
          `model: ${args.session.provider.modelId}`,
          `mode: ${args.session.securityMode}`,
          `projectTrust: ${args.session.projectTrusted ? "granted" : "global-only"}`,
          `sessionStore: ${args.manifest.storeId}`,
          `tools: ${args.tools.length}`,
        ].join("\n") + "\n",
      );
      return "handled";
    case "tools":
      args.deps.stdout.write(
        args.tools
          .map((tool) => `${tool.name}\t${tool.gated ? "gated" : "default-allowed"}`)
          .join("\n") + "\n",
      );
      return "handled";
    case "save-and-close":
      await args.persist(args.manifest, args.history);
      args.deps.stdout.write("session saved\n");
      return "exit";
    case "trust":
      args.deps.stdout.write("trust inspection is not wired to the CLI command surface yet\n");
      return "handled";
    case "reload":
      args.deps.stdout.write("reload is not wired to dynamic discovery yet\n");
      return "handled";
    case "network-policy":
      args.deps.stdout.write("network policy commands are not wired to this runtime yet\n");
      return "handled";
    case "model":
    case "provider":
    case "sm":
      args.deps.stdout.write(`${name} command is not wired to runtime switching yet\n`);
      return "handled";
    default:
      args.deps.stdout.write(
        `unknown command '/${name ?? ""}'${rest.length > 0 ? ` ${rest.join(" ")}` : ""}\n`,
      );
      return "handled";
  }
}
