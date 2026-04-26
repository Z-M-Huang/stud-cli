/**
 * Versioning primitives for contracts and core compatibility ranges.
 *
 * `SemVer`      — a concrete version triple `MAJOR.MINOR.PATCH`.
 *                 Encoded as a template-literal type so invalid strings fail
 *                 the type checker at assignment time.
 *
 * `SemVerRange` — a free-form SemVer range expression (e.g., ">=1.0.0 <2.0.0").
 *                 Kept as `string` because the range DSL is too wide to encode
 *                 as a template literal without losing ergonomics. Core validates
 *                 range syntax at runtime using a compliant semver library.
 *
 * Wiki: contracts/Versioning-and-Compatibility.md
 */
export type SemVer = `${number}.${number}.${number}`;

export type SemVerRange = string;
