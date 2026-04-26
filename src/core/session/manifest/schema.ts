/**
 * SESSION_MANIFEST_SCHEMA — frozen JSON Schema (draft 2020-12 URI) for the
 * slim session manifest.
 *
 * Slim shape per Q-2: schemaVersion + sessionId + projectRoot + mode +
 * createdAtMonotonic + updatedAtMonotonic + messages[] + smState? + writtenByStore.
 * `additionalProperties: false` at the top level prevents unknown keys.
 *
 * Note: strip the `$schema` key before passing to AJV v6 (the version pinned
 * in package.json), which does not recognise the 2020-12 meta-schema URI.
 *
 * Wiki: core/Session-Manifest.md
 */

/**
 * Frozen JSON Schema for `SessionManifest`.
 *
 * The `$schema` key uses the draft 2020-12 URI for documentation purposes.
 * Strip it before passing to AJV v6 (see `serializer.ts`).
 */
export const SESSION_MANIFEST_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "sessionId",
    "projectRoot",
    "mode",
    "createdAtMonotonic",
    "updatedAtMonotonic",
    "messages",
    "writtenByStore",
  ],
  properties: {
    schemaVersion: {
      type: "string",
      minLength: 1,
    },
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
    createdAtMonotonic: {
      type: "string",
      minLength: 1,
    },
    updatedAtMonotonic: {
      type: "string",
      minLength: 1,
    },
    messages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "role", "content", "monotonicTs"],
        properties: {
          id: { type: "string", minLength: 1 },
          role: { type: "string", enum: ["user", "assistant", "tool"] },
          content: {},
          monotonicTs: { type: "string", minLength: 1 },
        },
      },
    },
    smState: {
      type: "object",
      additionalProperties: false,
      required: ["smExtId", "slotVersion", "slot"],
      properties: {
        smExtId: { type: "string", minLength: 1 },
        slotVersion: { type: "string", minLength: 1 },
        slot: {},
      },
    },
    writtenByStore: {
      type: "string",
      minLength: 1,
    },
  },
});
