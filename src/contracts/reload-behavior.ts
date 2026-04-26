/**
 * Declares when an extension may be reloaded without restarting the session.
 *
 * `'in-turn'`       — core may reload the extension at any stage boundary
 *   within an active turn (least restrictive; suitable for stateless extensions
 *   such as tools and commands).
 *
 * `'between-turns'` — reload is only safe between turns, when no LLM request
 *   is in flight. Most extensions that hold per-turn state use this.
 *
 * `'never'`         — reloading requires a full session restart. Use this for
 *   extensions that write immutable session-level state on activation (e.g.,
 *   the session store itself, or extensions that mutate the process environment).
 *
 * Wiki: runtime/Extension-Reloading.md + contracts/Contract-Pattern.md
 */
export type ReloadBehavior = "in-turn" | "between-turns" | "never";
