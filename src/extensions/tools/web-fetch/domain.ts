/**
 * Domain extraction for the web-fetch approval key (Q-8 resolution).
 *
 * Returns the URL's hostname verbatim — e.g., `https://api.github.com/x`
 * yields `"api.github.com"`, and `https://www.example.com/x` yields
 * `"www.example.com"`. Subdomains on a different host string thus get
 * separate approval tokens (mirroring the spec example).
 *
 * Note: this does NOT consult the Public Suffix List. A registrable-suffix
 * implementation would require shipping or fetching the PSL; the reference
 * tool deliberately uses the raw hostname so the security boundary is
 * predictable from the URL alone.
 *
 * Returns `null` when the URL is unparsable or its hostname is empty;
 * callers should treat `null` as "input invalid" — the executor uses this
 * to surface `ToolTerminal/InputInvalid` rather than calling out.
 *
 * Wiki: reference-extensions/tools/Web-Fetch.md (Q-8 resolution)
 */

export function extractDomain(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (host.length === 0) {
    return null;
  }
  return host;
}

export function isHttpScheme(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}
