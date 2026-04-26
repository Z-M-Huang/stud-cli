/**
 * Abstract base for all typed errors in stud-cli.
 *
 * Rules enforced here:
 *   - `code` lives in `context.code`, never encoded in the message string.
 *   - `cause` is preserved through the Error cause chain for audit traversal.
 *   - `toModelShape()` produces class + code + context only (no stack, no cause).
 *   - `toAuditShape()` produces the full chain including cause and stack.
 *
 * Wiki: core/Error-Model.md
 */

export type ErrorClass =
  | "Validation"
  | "ProviderTransient"
  | "ProviderCapability"
  | "ToolTransient"
  | "ToolTerminal"
  | "Session"
  | "Cancellation"
  | "ExtensionHost";

export interface ModelErrorShape {
  readonly class: ErrorClass;
  readonly code: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface AuditErrorShape {
  readonly class: ErrorClass;
  readonly code: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly cause: unknown;
  readonly stack: string | undefined;
}

export abstract class StudError extends Error {
  /** Discriminant for the error category. Set by each concrete subclass. */
  abstract override readonly name: string;
  abstract readonly class: ErrorClass;

  /** Structured context bag. `context.code` is the canonical error code. */
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, cause?: unknown, context: Readonly<Record<string, unknown>> = {}) {
    // Pass cause to the Error base so the native `.cause` chain is populated.
    super(message, cause !== undefined ? { cause } : undefined);
    this.context = context;
  }

  /**
   * The error code read from `context.code`.
   * Returns an empty string if the caller omitted `code` in context (non-conformant;
   * conformance tests enforce its presence).
   */
  get code(): string {
    const c = this.context["code"];
    return typeof c === "string" ? c : "";
  }

  /**
   * Model-facing shape: class + code + context only.
   * No stack trace. No cause chain. Safe to send to the LLM.
   * Wiki: core/Error-Model.md § "User vs. model vs. audit surfaces".
   */
  toModelShape(): ModelErrorShape {
    return {
      class: this.class,
      code: this.code,
      context: this.context,
    };
  }

  /**
   * Audit-facing shape: full chain including cause and stack.
   * Never sent to the LLM; consumed by loggers and audit trail only.
   * Wiki: core/Error-Model.md § "User vs. model vs. audit surfaces".
   */
  toAuditShape(): AuditErrorShape {
    return {
      class: this.class,
      code: this.code,
      context: this.context,
      cause: this.cause,
      stack: this.stack,
    };
  }
}
