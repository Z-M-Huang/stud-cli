import { ToolTerminal } from "../../../core/errors/index.js";

import type { HostAPI } from "../../../core/host/host-api.js";

/**
 * Verify that `resolvedPath` falls within the session's trusted scope.
 *
 * A path that is exactly the project root or begins with `<projectRoot>/`
 * is trusted automatically (invariant #5 — project root is `<cwd>/.stud`).
 * Any path outside the project root requires explicit user confirmation via
 * the Interaction Protocol before any filesystem I/O is performed.
 *
 * Throws `ToolTerminal/Forbidden` when:
 *   - the user declines the confirmation prompt, or
 *   - the interaction surface is unavailable (headless mode, stub, cancellation).
 *
 * Note: traversal detection (`..` path components) is performed by the caller
 * *before* calling this function. This function receives an already-resolved,
 * canonical absolute path.
 *
 * Security invariant #2 (LLM context isolation): this function never touches
 * environment variables, `settings.json`, provider credentials, or secrets.
 *
 * Wiki: reference-extensions/context-providers/System-Prompt-File.md
 *       + security/Project-Trust.md + security/LLM-Context-Isolation.md
 */
export async function checkPathTrust(resolvedPath: string, host: HostAPI): Promise<void> {
  const projectRoot = host.session.projectRoot;

  // Paths that are exactly the project root or descend from it are trusted.
  const rootPrefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
  if (resolvedPath === projectRoot || resolvedPath.startsWith(rootPrefix)) {
    return;
  }

  // External path: ask for explicit user confirmation before any I/O.
  let allowed = false;
  try {
    const result = await host.interaction.raise({
      kind: "confirm",
      prompt: `Allow system-prompt-file to read a path outside the project root: ${resolvedPath}?`,
    });
    allowed = result.value === "yes";
  } catch (err) {
    host.events.emit("SuppressedError", {
      reason: "interaction unavailable or user cancelled — treating external-path read as denied",
      cause: String(err),
    });
  }

  if (!allowed) {
    throw new ToolTerminal(
      `read of '${resolvedPath}' outside the trusted project scope was denied`,
      undefined,
      { code: "Forbidden", path: resolvedPath },
    );
  }
}
