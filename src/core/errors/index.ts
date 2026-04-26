/**
 * Barrel export for the stud-cli typed error hierarchy.
 *
 * Exports exactly the eight concrete subclasses, the abstract base, the
 * ErrorClass discriminant union, and the SuppressedErrorEvent structural type.
 *
 * Wiki: core/Error-Model.md
 */
export { StudError } from "./base.js";
export type { AuditErrorShape, ErrorClass, ModelErrorShape } from "./base.js";
export { Cancellation } from "./cancellation.js";
export { ExtensionHost } from "./extension-host.js";
export { ProviderCapability } from "./provider-capability.js";
export { ProviderTransient } from "./provider-transient.js";
export { Session } from "./session.js";
export type { SuppressedErrorEvent } from "./suppressed-event.js";
export { ToolTerminal } from "./tool-terminal.js";
export { ToolTransient } from "./tool-transient.js";
export { Validation } from "./validation.js";
