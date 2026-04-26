/**
 * Hostname validator for the /network-policy command.
 *
 * Delegates to the Network-Policy core module's validation logic by probing
 * `loadNetworkPolicy` — avoids duplicating the host-pattern regex defined in
 * `src/core/network/policy.ts`.
 *
 * @throws `ToolTerminal/InputInvalid` when `host` is empty, contains '/',
 *   or otherwise fails the core module's hostname pattern.
 *
 * Wiki: runtime/Network-Policy.md
 */
import { ToolTerminal } from "../../../../core/errors/tool-terminal.js";
import { loadNetworkPolicy } from "../../../../core/network/policy.js";

/**
 * Validate a hostname string using the Network-Policy core module's rules.
 *
 * Internally probes `loadNetworkPolicy` with a project-scoped entry so that
 * validation logic stays in one place (the core module). If the core module
 * rejects the entry, this function re-throws as `ToolTerminal/InputInvalid`.
 *
 * @throws `ToolTerminal/InputInvalid` when `host` is not a valid hostname.
 */
export function validateHostname(host: string): void {
  try {
    loadNetworkPolicy([{ host, scope: "project" }], [], []);
  } catch (err) {
    // Check `.class` instead of `instanceof Validation` to handle the module
    // boundary between policy.js (imports from .ts) and this module (imports
    // from .js). The two share the same Validation shape but distinct instances.
    const isValidation =
      err !== null && typeof err === "object" && (err as { class?: string }).class === "Validation";
    if (isValidation) {
      throw new ToolTerminal(
        `invalid hostname '${host}' — must be a non-empty hostname matching the network-policy pattern (e.g. 'api.example.com')`,
        err,
        { code: "InputInvalid", host },
      );
    }
    throw err;
  }
}
