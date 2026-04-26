/**
 * HostAPI — the complete set of services exposed to every extension.
 *
 * Each extension receives one `HostAPI` instance, scoped to its own identity
 * and frozen at construction (the shape does not grow new methods at runtime).
 * Sub-surfaces are individually documented in `./api/`.
 *
 * Sanctioned surfaces (twelve total):
 *   session      — session id, mode, projectRoot, stateSlot
 *   events       — projection-only event bus (on / off / emit)
 *   config       — scoped configuration reader (readOwn)
 *   env          — single-credential env resolver (get only — invariant #2)
 *   tools        — read-only tool registry
 *   prompts      — prompt-registry URI resolution
 *   resources    — resource-binding fetch
 *   mcp          — trust-aware MCP client proxy
 *   audit        — structured audit-trail writer
 *   observability — projection event emission + SuppressedError
 *   interaction  — Interaction-Protocol request surface
 *   commands     — slash-command dispatch (Command / UI extensions only)
 *
 * Wiki: core/Host-API.md
 */
import type { AuditAPI } from "./api/audit.js";
import type { CommandsAPI } from "./api/commands.js";
import type { ConfigAPI } from "./api/config.js";
import type { EnvAPI } from "./api/env.js";
import type { EventsAPI } from "./api/events.js";
import type { InteractionAPI } from "./api/interaction.js";
import type { MCPAPI } from "./api/mcp.js";
import type { ObservabilityAPI } from "./api/observability.js";
import type { PromptsAPI } from "./api/prompts.js";
import type { ResourcesAPI } from "./api/resources.js";
import type { SessionAPI } from "./api/session.js";
import type { ToolsAPI } from "./api/tools.js";

export type { AuditAPI } from "./api/audit.js";
export type { CommandsAPI } from "./api/commands.js";
export type { ConfigAPI } from "./api/config.js";
export type { EnvAPI } from "./api/env.js";
export type { EventsAPI } from "./api/events.js";
export type { InteractionAPI } from "./api/interaction.js";
export type { MCPAPI } from "./api/mcp.js";
export type { ObservabilityAPI } from "./api/observability.js";
export type { PromptsAPI } from "./api/prompts.js";
export type { ResourcesAPI } from "./api/resources.js";
export type { SessionAPI, StateSlotHandle } from "./api/session.js";
export type { ToolsAPI } from "./api/tools.js";

/**
 * The complete host surface given to every extension.
 *
 * All properties are `readonly`. The host freezes the instance before handing
 * it to `init`, so extensions cannot add or replace surface methods.
 *
 * AC-56: shape exposes exactly the twelve sanctioned surfaces below.
 */
export interface HostAPI {
  /** Session id, security mode, project root, and per-extension state slots. */
  readonly session: SessionAPI;

  /** Projection-only event bus. Extensions observe and emit; they do not intercept. */
  readonly events: EventsAPI;

  /**
   * Scoped configuration reader.
   * Returns the extension's own validated config via `readOwn()`.
   */
  readonly config: ConfigAPI;

  /**
   * Single-credential environment surface.
   * Exposes `get(name)` only — no bulk-read API (invariant #2).
   */
  readonly env: EnvAPI;

  /** Read-only tool registry. Extensions inspect; they register via their contract. */
  readonly tools: ToolsAPI;

  /** Prompt-registry URI resolution. */
  readonly prompts: PromptsAPI;

  /** Resource-binding fetch, mediated by trust and network policy. */
  readonly resources: ResourcesAPI;

  /** Trust-aware MCP client proxy. */
  readonly mcp: MCPAPI;

  /**
   * Structured audit-trail writer.
   * Records are automatically stamped with `extId`, `sessionId`, and timestamp.
   */
  readonly audit: AuditAPI;

  /**
   * Projection event emission.
   * Includes `suppress()` for conformant swallowing of errors.
   */
  readonly observability: ObservabilityAPI;

  /** Interaction-Protocol request surface (confirm / input / select). */
  readonly interaction: InteractionAPI;

  /**
   * Slash-command dispatch.
   * Only `Command` and `UI` extensions receive a functional implementation;
   * all other categories receive a stub that throws `ToolTerminal/Forbidden`.
   */
  readonly commands: CommandsAPI;
}
