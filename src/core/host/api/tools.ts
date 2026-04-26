/**
 * ToolsAPI — read-only tool registry surface for extensions.
 *
 * Extensions may inspect registered tools (e.g., to decide whether to compose
 * with a specific tool) but may not mutate the registry through this surface.
 * Tool registration goes through the Tool extension contract at load time.
 *
 * Wiki: core/Host-API.md + contracts/Tools.md
 */

/**
 * Minimal descriptor of a registered tool as visible to other extensions.
 * The full tool definition (executor, schema, approval policy) lives in the
 * Tool extension's contract implementation.
 */
export interface ToolDescriptor {
  /** Unique tool identifier (e.g. `"bash"`, `"edit"`). */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Which extension registered this tool. */
  readonly registeredBy: string;
}

/** Read-only tool registry surface. */
export interface ToolsAPI {
  /**
   * List all currently registered tools.
   * Returns a snapshot; the list does not update reactively after the call.
   */
  list(): readonly ToolDescriptor[];

  /**
   * Look up a single tool by its identifier.
   * Returns `undefined` when no tool with that id is registered.
   *
   * @param id - The tool identifier.
   */
  get(id: string): ToolDescriptor | undefined;
}
