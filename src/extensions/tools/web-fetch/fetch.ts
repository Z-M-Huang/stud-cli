/**
 * Bounded streaming fetch with a timeout.
 *
 * Wraps `globalThis.fetch` to:
 *   - abort the request when `timeoutMs` elapses (timeout becomes a typed
 *     `ToolTransient/ExecutionTimeout` upstream).
 *   - read the response body up to `maxBytes` bytes, returning `truncated`
 *     when more bytes were available.
 *   - decode the captured bytes as UTF-8 (lossy fallback to replacement
 *     characters when the response is not valid UTF-8 — the body is
 *     already marked `untrusted` upstream, so a partial decode is acceptable
 *     and avoids a separate OutputMalformed surface for binary content).
 *
 * Pure I/O against `node:fetch`; the executor maps errors to typed shapes.
 *
 * Wiki: reference-extensions/tools/Web-Fetch.md
 */

export interface FetchOutcome {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly truncated: boolean;
}

export interface BoundedFetchOptions {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly method: "GET" | "HEAD";
  readonly headers: Readonly<Record<string, string>>;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export async function boundedFetch(url: string, opts: BoundedFetchOptions): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: opts.method,
      headers: opts.headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const headersRecord = headersToRecord(response.headers);

  if (opts.method === "HEAD" || response.body === null) {
    return { status: response.status, headers: headersRecord, body: "", truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const read = await reader.read();
    if (read.done) break;
    const value = read.value as Uint8Array | undefined;
    if (value === undefined) continue;
    if (total + value.length > opts.maxBytes) {
      const allowed = opts.maxBytes - total;
      if (allowed > 0) {
        chunks.push(value.slice(0, allowed));
        total += allowed;
      }
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        // Suppressed: cancel-after-truncation is best effort.
      }
      break;
    }
    chunks.push(value);
    total += value.length;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  // Lossy decode: web-fetch bodies are marked untrusted upstream. A binary
  // payload should not crash the tool; downstream consumers are expected to
  // treat the string as opaque adversarial content.
  const body = new TextDecoder("utf-8", { fatal: false }).decode(merged);

  return { status: response.status, headers: headersRecord, body, truncated };
}
