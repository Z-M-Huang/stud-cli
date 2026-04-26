export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error";

export function mapFinishReason(rawReason: string): FinishReason {
  switch (rawReason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "tool-calls":
      return "tool_calls";
    case "content_filter":
    case "content-filter":
      return "content_filter";
    default:
      return "error";
  }
}
