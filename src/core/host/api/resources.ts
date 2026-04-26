/**
 * ResourcesAPI — resource-registry binding and fetch surface.
 *
 * Extensions may fetch named resources (files, URLs, MCP resource URIs) that
 * have been bound in the resource registry. Access is mediated by core to
 * enforce trust and network policies.
 *
 * Wiki: core/Resource-Registry.md + core/Host-API.md + runtime/Network-Policy.md
 */

/** A fetched resource payload. */
export interface FetchedResource {
  /** The URI that was fetched. */
  readonly uri: string;
  /** MIME type of the returned content, if known. */
  readonly mimeType: string | undefined;
  /** Raw content as a string (text) or Uint8Array (binary). */
  readonly content: string | Uint8Array;
}

/** Resource-registry binding and fetch surface. */
export interface ResourcesAPI {
  /**
   * Fetch a resource by its URI.
   *
   * Network access is governed by the active network policy (runtime/Network-Policy.md).
   * Throws `ToolTerminal/NotFound` when the resource cannot be located.
   * Throws `ToolTransient/ExecutionTimeout` on transient fetch failures.
   * Throws `ToolTerminal/Forbidden` when network policy denies the access.
   *
   * @param uri - The resource URI.
   */
  fetch(uri: string): Promise<FetchedResource>;
}
