/**
 * `systemMessageMode: "remove"` cross-field guard.
 *
 * Wiki: contracts/Provider-Params.md, providers/OpenAI-Compatible.md (line 149),
 *       context/Context-Assembly.md (line 50).
 *
 * The schema accepts `systemMessageMode: "remove"` as a legal enum value; the
 * rejection runs **here**, at request-assembly time, when the assembled
 * `system` layer is load-bearing — i.e., it carries an SM stage body or any
 * `system-message` Context Provider contribution. Removing such a layer
 * silently breaks the agent's behavior, so we throw a typed `Validation`
 * error and emit a loud diagnostic.
 */
import { Validation } from "../errors/validation.js";

/**
 * Provenance tag for assembled system-layer content. Each contribution to the
 * single `system` string (the merged SystemPromptFile content + any
 * system-message Context Provider) carries one of these tags. The guard
 * treats `sm-stage-body` and `system-message-provider` as load-bearing.
 */
export type SystemLayerProvenance =
  | "sm-stage-body"
  | "system-message-provider"
  | "static-system-prompt";

export interface SystemLayerSegment {
  readonly text: string;
  readonly provenance: SystemLayerProvenance;
}

/**
 * Returns true when the assembled system layer carries any segment whose
 * provenance is load-bearing for the agent (SM stage body or
 * system-message Context Provider). Empty / static-only layers are not
 * load-bearing.
 */
export function isSystemLayerLoadBearing(segments: readonly SystemLayerSegment[]): boolean {
  return segments.some(
    (s) =>
      s.text.length > 0 &&
      (s.provenance === "sm-stage-body" || s.provenance === "system-message-provider"),
  );
}

export interface AssertSystemMessageModeAllowedInput {
  readonly params: Readonly<Record<string, unknown>>;
  readonly systemLayer: readonly SystemLayerSegment[];
  readonly providerEntryId: string;
  readonly modelId: string;
}

/**
 * Reject `systemMessageMode: "remove"` when the assembled system layer is
 * load-bearing. Emits a loud diagnostic via the typed `Validation` error.
 *
 * Per `wiki/providers/OpenAI-Compatible.md:149`: "**`"remove"` interaction
 * with [Context Assembly](Context-Assembly) is load-bearing**: when the
 * assembled system layer carries SM-stage bodies or `system-message` Context
 * Provider contributions, `systemMessageMode: "remove"` emits a loud
 * diagnostic and is **rejected** when the system layer is load-bearing."
 */
export function assertSystemMessageModeAllowed(input: AssertSystemMessageModeAllowedInput): void {
  const mode = input.params["systemMessageMode"];
  if (mode !== "remove") return;
  if (!isSystemLayerLoadBearing(input.systemLayer)) return;

  throw new Validation(
    `provider entry '${input.providerEntryId}' on model '${input.modelId}' rejects systemMessageMode: "remove" because the assembled system layer is load-bearing`,
    undefined,
    {
      code: "SystemModeRemoveLoadBearing",
      providerEntryId: input.providerEntryId,
      modelId: input.modelId,
      loadBearingSegments: input.systemLayer
        .filter(
          (s) =>
            s.text.length > 0 &&
            (s.provenance === "sm-stage-body" || s.provenance === "system-message-provider"),
        )
        .map((s) => s.provenance),
    },
  );
}
