/**
 * ConfigAPI — scoped configuration reader for extensions.
 *
 * Each extension receives a `ConfigAPI` instance already scoped to its own
 * config namespace. An extension may only read its own validated configuration;
 * it cannot read another extension's config or any global/project scope directly.
 *
 * Core resolves configuration through the three-scope cascade
 * (bundled → global → project) before surfacing it here. By the time
 * `readOwn()` is called, the config has already been validated against the
 * extension's `configSchema`.
 *
 * Wiki: core/Host-API.md + runtime/Scope-Layering.md
 */

/**
 * Scoped configuration reader.
 * The type parameter `TConfig` is the validated config shape declared by the
 * extension's `configSchema`. Core narrows the return type per extension.
 */
export interface ConfigAPI<TConfig = Readonly<Record<string, unknown>>> {
  /**
   * Return the extension's own resolved and validated configuration.
   * The return value is frozen; mutations are silently ignored.
   *
   * Throws `Validation/ConfigSchemaViolation` if the active config does not
   * satisfy the extension's schema (should never happen in practice — core
   * validates at load time, but defensive re-validation may occur on reload).
   */
  readOwn(): Promise<TConfig>;
}
