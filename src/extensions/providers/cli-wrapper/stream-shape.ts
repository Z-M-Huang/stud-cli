import { mapFinishReason } from "../_adapter/finish-mapper.js";
import { createToolCallAssembler } from "../_adapter/tool-call-assembler.js";

import type { ProviderStreamEvent } from "../../../contracts/providers.js";

export async function* shapeCLIStream(
  stdout: AsyncIterable<Uint8Array>,
): AsyncGenerator<ProviderStreamEvent> {
  const assembler = createToolCallAssembler();

  for await (const chunk of stdout) {
    yield {
      type: "text-delta",
      delta: Buffer.from(chunk).toString("utf8"),
    };
  }

  const finish: ProviderStreamEvent = {
    type: "finish",
    reason: mapFinishReason("stop") === "tool_calls" ? "tool-calls" : "stop",
  };

  assembler.ingest({ kind: "finish", reason: mapFinishReason("stop") });
  for (const event of assembler.drain()) {
    if (event.kind === "tool-call") {
      yield {
        type: "tool-call",
        toolCallId: event.callId,
        toolName: event.name,
        args: (event.args ?? {}) as Readonly<Record<string, unknown>>,
      };
    }
  }

  yield finish;
}
