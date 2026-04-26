/**
 * Interaction-Protocol request serializer.
 *
 * Provides a round-trip byte codec for `InteractionRequest` values.
 * The encoding is JSON serialized to UTF-8.  No compression or encryption —
 * the protocol layer is responsible for transport security.
 *
 * ## Guarantees
 *
 * - `serializeRequest` + `deserializeRequest` is byte-identical round-trip for
 *   any valid `InteractionRequest`.
 * - `deserializeRequest` does NOT validate the payload structure — callers must
 *   pass the result through `createInteractionProtocol.raise` to get protocol-
 *   level validation.
 *
 * Wiki: core/Interaction-Protocol.md
 */

import type { InteractionRequest } from "./protocol.js";

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Serialize an `InteractionRequest` to a UTF-8 encoded JSON byte array.
 *
 * The returned `Uint8Array` is a new buffer on each call.
 */
export function serializeRequest(req: InteractionRequest): Uint8Array {
  return encoder.encode(JSON.stringify(req));
}

/**
 * Deserialize a `Uint8Array` produced by `serializeRequest` back into an
 * `InteractionRequest`.
 *
 * Throws a plain `SyntaxError` when `buf` is not valid JSON; throws a
 * `TypeError` when the decoded value is not an object.  Neither case uses a
 * typed `StudError` because this is an explicit transport-boundary decode that
 * callers are responsible for guarding — the protocol validates the decoded
 * request shape at `raise` time.
 */
export function deserializeRequest(buf: Uint8Array): InteractionRequest {
  const text = decoder.decode(buf);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("deserializeRequest: decoded value is not an object");
  }
  return parsed as InteractionRequest;
}
