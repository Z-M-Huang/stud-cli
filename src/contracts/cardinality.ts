/**
 * Cardinality types for extension loading and activation axes.
 *
 * `LoadedCardinality` — how many instances of this extension may be loaded
 *   at one time across the session.
 *   - `'unlimited'` — no cap (most categories).
 *   - `'one'`       — exactly one instance may load (rare singletons).
 *   - `{ kind: 'n'; n: number }` — at most N instances.
 *
 * `ActiveCardinality` — how many instances may be active simultaneously.
 *   - `'unlimited'`    — no cap (most categories).
 *   - `'one'`          — exactly one active at a time (UI interactor, Session Store).
 *   - `'one-attached'` — exactly one attached per turn (State Machine stages).
 *
 * Wiki: contracts/Cardinality-and-Activation.md + contracts/Contract-Pattern.md
 */
export type LoadedCardinality = "unlimited" | "one" | { readonly kind: "n"; readonly n: number };

export type ActiveCardinality = "unlimited" | "one" | "one-attached";
