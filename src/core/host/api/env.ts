/**
 * EnvAPI — reference-returning environment variable surface.
 *
 * This is the sole credential surface exposed to extensions. It returns a
 * single value by name; there is deliberately no list, all, or entries method.
 *
 * Invariant #2 (LLM context isolation): environment variables and settings.json
 * do NOT enter the LLM request. Extensions may resolve individual env vars for
 * their own operation, but there is no bulk-read-env API. Any attempt to expose
 * all env vars to the model is a bug.
 *
 * Invariant #6 (session manifest never stores resolved secrets): `get(name)`
 * resolves the value at the point of use; the manifest stores only the name
 * reference, never the resolved value.
 *
 * Wiki: core/Env-Provider.md + security/LLM-Context-Isolation.md
 *       + security/Secrets-Handling.md
 */

/** Reference-returning, single-credential environment surface. */
export interface EnvAPI {
  /**
   * Resolve the environment variable named `name` and return its value.
   *
   * Throws `Validation/EnvNameUndeclared` if the extension has not declared
   * this variable in its contract's `envRefs` (future contract field; checked
   * in a later unit).
   *
   * Throws `Validation/EnvNameNotSet` if the variable is declared but absent
   * from the process environment at resolution time.
   *
   * @param name - The exact environment-variable name (e.g. `"OPENAI_API_KEY"`).
   *
   * @note There is intentionally NO `list()`, `all()`, or `entries()` method on
   * this interface. Adding such a method is a critical security violation of
   * invariant #2. Do not add them.
   */
  get(name: string): Promise<string>;
}
