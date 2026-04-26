/**
 * WebFetchResult — output shape returned by the web-fetch reference tool.
 *
 * `untrusted: true` is a pinned literal to mark the body as content that may
 * contain prompt-injection material. Downstream consumers (e.g., Context
 * Providers, the message loop) MUST treat `body` as adversarial input.
 *
 * Wiki: reference-extensions/tools/Web-Fetch.md + security/LLM-Context-Isolation.md
 */

export interface WebFetchResult {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly truncated: boolean;
  readonly untrusted: true;
}
