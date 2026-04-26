/**
 * Cardinality-and-Activation reference example.
 *
 * Demonstrates how `assertCategoryCardinality` validates a declared shape.
 * Covers the successful case (StateMachine, one-attached) and the failing case
 * (UI declared as active:one, which violates the Q-9 resolution).
 *
 * Wiki: contracts/Cardinality-and-Activation.md
 */
import {
  CATEGORY_CARDINALITY,
  assertCategoryCardinality,
} from "../../../src/contracts/cardinality-and-activation.js";

// --- Successful case: StateMachine declared with the canonical one-attached ---

const smResult = assertCategoryCardinality("StateMachine", {
  loaded: "unlimited",
  active: "one-attached",
});

console.assert(smResult.ok === true, "StateMachine one-attached should match canonical map");

// --- Successful case: SessionStore active:one (single active store invariant) ---

const ssResult = assertCategoryCardinality("SessionStore", {
  loaded: "unlimited",
  active: "one",
});

console.assert(ssResult.ok === true, "SessionStore active:one should match canonical map");

// --- Failing case: UI declared as active:one (pre-Q-9 assumption, now incorrect) ---
//
// Before Q-9 the UI interactor had activeCardinality:'one'. Q-9 resolved this to
// 'unlimited' (interactor/subscriber distinction moved to the UI contract's `roles`
// array). Declaring UI with active:'one' now produces a CardinalityMismatch.

const uiResult = assertCategoryCardinality("UI", { loaded: "unlimited", active: "one" });

console.assert(uiResult.ok === false, "UI active:one should fail (post Q-9)");

if (!uiResult.ok) {
  console.assert(
    uiResult.error.code === "CardinalityMismatch",
    "Error code should be CardinalityMismatch",
  );
  console.assert(
    uiResult.error.expected.active === "unlimited",
    "expected.active should be 'unlimited'",
  );
}

// --- Inspect the canonical map ---

console.assert(Object.isFrozen(CATEGORY_CARDINALITY), "CATEGORY_CARDINALITY is frozen");
console.assert(Object.keys(CATEGORY_CARDINALITY).length === 9, "Nine categories in the map");

console.log("All assertions passed.");
