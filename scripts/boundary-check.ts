/**
 * Extensibility boundary checker.
 * Ensures no new file is added under src/core/ that is not on the wiki's
 * core-surface allowlist.
 *
 * See overview/Extensibility-Boundary.md and CLAUDE.md §7.
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

interface Violation {
  file: string;
  reason: string;
}
type Result = { ok: true } | { ok: false; violations: readonly Violation[] };

const WIKI_PAGE = "overview/Extensibility-Boundary.md";

/**
 * Allowlisted top-level stems for src/core/.
 * Source: overview/Extensibility-Boundary.md — "What core owns (non-extensible)".
 * Each entry maps to one responsibility bullet on that wiki page.
 */
const CORE_ALLOWLIST = new Set([
  // Message loop — core/Message-Loop.md
  "loop",
  // Event bus — core/Event-Bus.md
  "events",
  // Command dispatcher (kernel; bundled commands are extensions) — contracts/Commands.md
  "commands",
  // Interaction protocol — core/Interaction-Protocol.md
  "interaction",
  // Session format / lifecycle / persistence
  // — core/{Session-Manifest,Session-Lifecycle,Persistence-and-Recovery}.md
  "session",
  "session-lifecycle",
  "persistence",
  // Context assembly — context/Context-Assembly.md
  "context",
  // Registries — core/{Prompt-Registry,Resource-Registry}.md
  "prompts",
  "resources",
  // Env provider — core/Env-Provider.md
  "env",
  // Host API surface — core/Host-API.md
  "host",
  // Extension lifecycle / discovery / installation / integrity
  // — core/Extension-Lifecycle.md + runtime/{Extension-Discovery,Extension-Installation}.md
  // + security/Extension-Integrity.md
  "lifecycle",
  "discovery",
  "install",
  "integrity",
  // Configuration scopes / settings / project root
  // — runtime/{Configuration-Scopes,Project-Root}.md + contracts/Settings-Shape.md
  // + security/Project-Trust.md
  "config",
  "settings",
  "project",
  // Security: modes / approval / trust / secrets-hygiene / extension-isolation / network policy
  // — security/* + runtime/Network-Policy.md
  "security",
  "extension-isolation",
  "network",
  // MCP client — integrations/MCP.md
  "mcp",
  // Observability scaffolding (instrumentation; sinks are Loggers extensions)
  // — operations/{Observability,Health-and-Diagnostics}.md
  "observability",
  "diagnostics",
  // Capability negotiation runtime — contracts/Capability-Negotiation.md
  "capabilities",
  // Hook runner (kernel; extensions live in src/extensions/hooks/) — contracts/Hooks.md
  "hooks",
  // State Machine runner (kernel; extensions live in src/extensions/state-machines/)
  // — contracts/State-Machines.md
  "sm",
  // Cross-cutting kernel infrastructure
  // — core/{Concurrency-and-Cancellation,Execution-Model}.md + runtime/Platform-Integration.md
  "concurrency",
  "execution-model",
  "platform",
  // Error classes (load-bearing for typed-error invariant) — core/Error-Model.md
  "errors",
]);

/**
 * Return the top-level stem for a relative path under src/core/.
 *
 * For a flat file (`"host-api.ts"`) this strips the extension to yield `"host-api"`.
 * For a directory path (`"errors/base.ts"`) this returns the directory name as-is
 * (`"errors"`) — no extension stripping, since directory names have no extension.
 *
 * The original implementation used `slice(lastIndexOf("."))` unconditionally; when
 * there is no `.` in the segment, `lastIndexOf` returns -1 and `slice(-1)` strips
 * the last character (e.g. `"errors"` → `"error"`, `"host"` → `"hos"`).
 */
function topLevelStem(relPath: string): string {
  const first = relPath.split("/")[0] ?? relPath;
  const dotIdx = first.lastIndexOf(".");
  if (dotIdx === -1) return first; // directory name or extensionless file — return as-is
  return first.slice(0, dotIdx);
}

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkDir(fullPath);
      files.push(...sub);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Walk `coreDir` and fail on any file whose top-level stem is not on the
 * core-surface allowlist.
 */
export async function runBoundaryCheck(coreDir: string): Promise<Result> {
  const allFiles = await walkDir(coreDir);
  const violations: Violation[] = [];

  for (const file of allFiles) {
    const rel = relative(coreDir, file);
    const stem = topLevelStem(rel);
    if (!CORE_ALLOWLIST.has(stem)) {
      violations.push({
        file,
        reason:
          `'${rel}' is not on the core-surface allowlist. ` +
          `If this belongs in core, update the wiki first: ${WIKI_PAGE}. ` +
          `If it can be replaced by an extension, move it to src/extensions/.`,
      });
    }
  }

  if (violations.length === 0) return { ok: true };
  return { ok: false, violations };
}

// CLI entry point
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const coreDir = "src/core";
  const result = await runBoundaryCheck(coreDir);
  if (!result.ok) {
    for (const v of result.violations) {
      process.stderr.write(`VIOLATION: ${v.reason}\n`);
    }
    process.stderr.write(`\nBoundary check failed: ${result.violations.length} violation(s)\n`);
    process.exit(1);
  }
  process.stdout.write("Boundary check: clean\n");
}
