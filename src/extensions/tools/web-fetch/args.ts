/**
 * WebFetchArgs — input arguments for the web-fetch reference tool.
 *
 * `url`        — required; the absolute http(s) URL to fetch.
 * `method`     — optional; "GET" (default) or "HEAD".
 * `headers`    — optional; outbound request headers.
 * `timeoutMs`  — optional; per-request timeout (default from config).
 *
 * Wiki: reference-extensions/tools/Web-Fetch.md
 */

export interface WebFetchArgs {
  readonly url: string;
  readonly method?: "GET" | "HEAD";
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}
