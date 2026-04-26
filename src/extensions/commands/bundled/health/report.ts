/**
 * HealthReport type for the /health bundled command.
 *
 * Re-exported from the core diagnostics probe — this command is a thin
 * adapter over the probe surface. The type is preserved verbatim so that
 * callers can import it from the command module without a direct core import.
 *
 * Shape (AC-110):
 *   {extensions, activeStore, activeInteractor, mode, sm?, mcp, loop}
 *
 * Wiki: operations/Health-and-Diagnostics.md
 */
export type { HealthReport } from "../../../../core/diagnostics/probe.js";
