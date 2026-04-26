import type { ModelErrorShape } from "../core/errors/base.js";

export interface ModelShapeProvider {
  readonly toModelShape: () => ModelErrorShape;
}

export function hasModelShape(error: unknown): error is ModelShapeProvider {
  return (
    error !== null &&
    typeof error === "object" &&
    "toModelShape" in error &&
    typeof error.toModelShape === "function"
  );
}

export function fallbackErrorShape(
  error: unknown,
  errorClass: ModelErrorShape["class"],
  code: string,
): ModelErrorShape | Readonly<Record<string, unknown>> {
  if (hasModelShape(error)) {
    return error.toModelShape();
  }

  return {
    class: errorClass,
    code,
    context: { message: error instanceof Error ? error.message : String(error) },
  };
}
