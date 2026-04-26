/**
 * PromptsAPI — prompt-registry resolution surface for extensions.
 *
 * Extensions (particularly Context Providers and State Machines) may resolve
 * named prompt templates by their URI. The resolved content is a rendered
 * string ready for inclusion in a request.
 *
 * Wiki: core/Prompt-Registry.md + core/Host-API.md
 */

/** A resolved prompt ready for inclusion in a composed request. */
export interface ResolvedPrompt {
  /** The URI that was resolved. */
  readonly uri: string;
  /** Fully rendered prompt content. */
  readonly content: string;
}

/** Prompt-registry resolution surface. */
export interface PromptsAPI {
  /**
   * Resolve a prompt by its URI.
   *
   * Throws `ToolTerminal/NotFound` if no prompt is registered at `uri`.
   * Throws `ToolTerminal/InputInvalid` if `uri` is malformed.
   *
   * @param uri - The prompt URI (scheme and path depend on the registered
   *   prompt provider; e.g., `"file:///path/to/system.md"` or
   *   `"stud:bundled/default-system"`).
   */
  resolveByURI(uri: string): Promise<ResolvedPrompt>;
}
