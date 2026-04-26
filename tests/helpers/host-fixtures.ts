import { mockHost } from "./mock-host.js";

import type { InteractionRequest, InteractionResult } from "../../src/core/host/api/interaction.js";
import type { HostAPI } from "../../src/core/host/host-api.js";

export interface FakeHostOptions {
  readonly onRaise?: (
    request: InteractionRequest,
  ) => Promise<InteractionResult> | InteractionResult;
}

export function fakeHost(options: FakeHostOptions = {}): HostAPI {
  const { host } = mockHost({ extId: "test-command" });

  return Object.freeze({
    ...host,
    interaction: Object.freeze({
      async raise(request: InteractionRequest): Promise<InteractionResult> {
        if (options.onRaise !== undefined) {
          return await options.onRaise(request);
        }
        return { value: "ok" };
      },
    }),
  });
}
