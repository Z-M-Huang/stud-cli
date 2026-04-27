import type { RuntimeToolResult } from "./types.js";

export function toolResultPayload(result: RuntimeToolResult): string {
  return result.ok
    ? typeof result.value === "string"
      ? result.value
      : JSON.stringify(result.value, null, 2)
    : JSON.stringify(
        {
          ok: false,
          error: {
            class: "ToolTerminal",
            code: "ToolExecutionFailed",
            message: "tool execution failed",
          },
        },
        null,
        2,
      );
}
