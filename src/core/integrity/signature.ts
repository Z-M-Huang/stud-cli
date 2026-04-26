export interface IntegrityToken {
  readonly algorithm: "sha256" | "sha512";
  readonly value: string;
  readonly fileSet: readonly string[];
}

export interface IntegrityManifest {
  readonly extId: string;
  readonly extensionRoot: string;
  readonly declaredToken: IntegrityToken | null;
  readonly origin: "bundled" | "first-party" | "third-party";
}

export type IntegrityOutcome =
  | { readonly status: "verified"; readonly algorithm: string }
  | { readonly status: "warned"; readonly reason: "third-party-no-token" }
  | { readonly status: "failed"; readonly expected: string; readonly actual: string };
