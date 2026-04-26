/**
 * Discovery rules that tell core where to find an extension on disk and how
 * to order it relative to peers in the same category.
 *
 * `folder`              — the subdirectory under the extension root that
 *   contains extensions of this category (e.g., `'tools'`, `'hooks'`).
 *
 * `manifestKey`         — the unique identifier for this extension within
 *   its folder as recorded in the project or global manifest.
 *
 * `orderingSubsystem`   — optional hint for categories that need
 *   deterministic ordering.  `'hooks'` applies the priority-then-name
 *   ordering defined in contracts/Hook-Taxonomy.md; `'none'` (default)
 *   leaves order unspecified.
 *
 * Wiki: runtime/Extension-Discovery.md + contracts/Contract-Pattern.md
 */
export interface DiscoveryRules {
  readonly folder: string;
  readonly manifestKey: string;
  readonly orderingSubsystem?: "hooks" | "none";
  readonly defaultActivation?: boolean;
}
