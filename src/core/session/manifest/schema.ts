/**
 * SESSION_MANIFEST_SCHEMA — frozen JSON Schema for the v1 slim session
 * manifest.
 *
 * Slim shape per Q-2: sessionId + projectRoot + mode + messages[] +
 * smState? + storeId + createdAt + updatedAt. Unknown top-level keys are
 * rejected. Message entries are intentionally opaque objects.
 *
 * Wiki: core/Session-Manifest.md
 */

export const SESSION_MANIFEST_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "projectRoot", "mode", "messages", "storeId", "createdAt", "updatedAt"],
  properties: {
    sessionId: {
      type: "string",
      minLength: 1,
    },
    projectRoot: {
      type: "string",
      minLength: 1,
    },
    mode: {
      type: "string",
      enum: ["ask", "yolo", "allowlist"],
    },
    messages: {
      type: "array",
      items: {
        type: "object",
      },
    },
    smState: {
      type: "object",
      additionalProperties: false,
      required: ["smExtId", "stateSlotRef"],
      properties: {
        smExtId: { type: "string", minLength: 1 },
        stateSlotRef: { type: "string", minLength: 1 },
      },
    },
    storeId: {
      type: "string",
      minLength: 1,
    },
    createdAt: {
      type: "number",
    },
    updatedAt: {
      type: "number",
    },
  },
});
