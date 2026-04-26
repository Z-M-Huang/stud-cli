/**
 * Standard config fixtures for extension contract conformance tests (AC-11).
 *
 * Every conformance test suite imports these three shapes:
 *   - `validConfigFixture`         — minimal conforming input; must be accepted.
 *   - `invalidConfigFixture`       — smallest type-violating input; must be rejected
 *                                    with an error whose `instancePath` points to
 *                                    the offending field.
 *   - `worstPlausibleConfigFixture` — realistic hostile input (oversized strings,
 *                                    prototype-pollution probe, extra fields);
 *                                    must be rejected without throwing or crashing.
 *
 * These fixtures are keyed on the minimal schema used in extension-skeleton tests
 * (`{ enabled: boolean }`). Extensions with richer schemas should derive
 * category-specific fixtures from these as a baseline.
 */

export const validConfigFixture: Readonly<Record<string, unknown>> = Object.freeze({
  enabled: true,
});

/**
 * Invalid because `enabled` is a string instead of the required boolean.
 * An AJV validator must reject this and report `instancePath: '/enabled'`.
 */
export const invalidConfigFixture: Readonly<Record<string, unknown>> = Object.freeze({
  enabled: "not-a-boolean",
});

/**
 * Realistic hostile input: oversized string field and a prototype-pollution
 * probe injected as an own enumerable key.
 *
 * Validators must reject this without crashing.
 * The serialized JSON is intentionally > 100 000 characters.
 *
 * Note: `'__proto__' in worstPlausibleConfigFixture` is always true (inherited
 * accessor on Object.prototype) even without an explicit own property; the
 * fixture also adds it as an own enumerable key via Object.assign to exercise
 * schema validators that inspect own keys.
 */
const _base: Record<string, unknown> = {
  enabled: true,
  // 110 001 chars ensures JSON.stringify length > 100 000
  extra: "x".repeat(110_001),
};
// Inject `__proto__` as an own enumerable string key (not as prototype setter)
// to probe schema validator resilience to prototype-pollution payloads.
Object.defineProperty(_base, "__proto__", {
  value: { polluted: true },
  enumerable: true,
  writable: true,
  configurable: true,
});

export const worstPlausibleConfigFixture: Readonly<Record<string, unknown>> = Object.freeze(_base);
