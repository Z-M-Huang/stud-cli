/**
 * Shared test stubs for the subagent-related additions to the host API.
 *
 * Test fixtures that construct ad-hoc SessionAPI / AuditAPI objects use these
 * stubs to satisfy the new fields without each test reinventing them. The
 * stubs reject / return empty by default — tests that exercise the actual
 * behavior should override these with real implementations.
 *
 * Wiki: core/Host-API.md §session.openChild and §audit (1.2.0).
 */

import { ExtensionHost } from "../../src/core/errors/index.js";

import type {
  ActiveSubagentEntry,
  AuditQueryFilter,
  AuditQueryRecord,
} from "../../src/core/host/api/audit.js";
import type { OpenChildArgs, OpenChildResult } from "../../src/core/host/api/session.js";

export function openChildStub(_args: OpenChildArgs): Promise<OpenChildResult> {
  return Promise.reject(
    new ExtensionHost("test stub: host.session.openChild is not wired in this fixture", undefined, {
      code: "Forbidden",
    }),
  );
}

export function auditQueryStub(_filter?: AuditQueryFilter): Promise<readonly AuditQueryRecord[]> {
  return Promise.resolve([]);
}

export function auditActiveSubagentsStub(): Promise<readonly ActiveSubagentEntry[]> {
  return Promise.resolve([]);
}

export const sessionAuditBusSubagentStub = {
  query: (): readonly AuditQueryRecord[] => [],
  activeSubagents: (): readonly ActiveSubagentEntry[] => [],
};
