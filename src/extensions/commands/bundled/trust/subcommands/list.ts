/**
 * /trust list subcommand — returns the trust list with no resolved secrets.
 *
 * Projects and MCP server entries are included. Secret material (tokens,
 * credentials) must never appear in the output — only public identifiers
 * (canonical path, server id, scope, grant timestamp).
 *
 * Wiki: reference-extensions/commands/trust.md
 */
import type { CommandResult } from "../../../../../contracts/commands.js";
import type { TrustContext } from "../lifecycle.js";

// ---------------------------------------------------------------------------
// Output shapes (payload only — no resolved secrets)
// ---------------------------------------------------------------------------

interface ProjectPayloadEntry {
  readonly canonicalPath: string;
  readonly grantedAt: string;
}

interface McpPayloadEntry {
  readonly serverId: string;
  readonly scope: string;
  readonly grantedAt: number;
}

interface TrustListPayload {
  readonly projects: readonly ProjectPayloadEntry[];
  readonly mcp: readonly McpPayloadEntry[];
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderList(
  projects: readonly ProjectPayloadEntry[],
  mcp: readonly McpPayloadEntry[],
): string {
  const projectLines =
    projects.length > 0
      ? projects.map((e) => `  ${e.canonicalPath}  (granted ${e.grantedAt})`)
      : ["  (none)"];

  const mcpLines =
    mcp.length > 0
      ? mcp.map(
          (e) => `  ${e.serverId} [${e.scope}]  (granted ${new Date(e.grantedAt).toISOString()})`,
        )
      : ["  (none)"];

  return [
    "Trust list",
    "==========",
    "",
    "Projects:",
    ...projectLines,
    "",
    "MCP servers:",
    ...mcpLines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute the `list` subcommand.
 *
 * All returned data is redacted to public identifiers only — no secrets,
 * no tokens, no resolved credentials. (Invariant #6.)
 */
export async function executeList(ctx: TrustContext): Promise<CommandResult> {
  const [projects, mcp] = await Promise.all([ctx.listProjectEntries(), ctx.listMcpEntries()]);

  // Build safe payload — only fields declared in the output shape interfaces.
  const projectPayload: ProjectPayloadEntry[] = projects.map((e) => ({
    canonicalPath: e.canonicalPath,
    grantedAt: e.grantedAt,
  }));

  const mcpPayload: McpPayloadEntry[] = mcp.map((e) => ({
    serverId: e.serverId,
    scope: e.scope,
    grantedAt: e.grantedAt,
  }));

  const payload: TrustListPayload = {
    projects: projectPayload,
    mcp: mcpPayload,
  };

  return {
    rendered: renderList(projectPayload, mcpPayload),
    payload: payload as unknown as Readonly<Record<string, unknown>>,
  };
}
