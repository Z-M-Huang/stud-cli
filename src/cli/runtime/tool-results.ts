import type { RuntimeToolResult } from "./types.js";

export function toolResultPayload(result: RuntimeToolResult): string {
  if (!result.ok) {
    const modelShape = result.error.toModelShape();
    return JSON.stringify(
      {
        ok: false,
        error: {
          ...modelShape,
          message: result.error.message,
        },
      },
      null,
      2,
    );
  }

  return typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2);
}
