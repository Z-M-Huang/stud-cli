import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ExtensionHost, Validation } from "../../../src/core/errors/index.js";
import {
  __auditEventsForTest,
  __emitSessionTurnEndForTest,
  __flushStageBoundaryForTest,
  __isDisabledForTest,
  __lifecycleCallsForTest,
  __registerActiveExtensionForTest,
  __resetReloadRuntimeForTest,
  __snapshotLoadedSetForTest,
  requestReload,
} from "../../../src/core/lifecycle/reloader.js";

afterEach(() => {
  __resetReloadRuntimeForTest();
});

describe("requestReload", () => {
  it("reloads an in-turn extension at the next stage boundary", async () => {
    __registerActiveExtensionForTest({ extId: "hook-x", reloadBehavior: "in-turn" });

    const pending = requestReload({ extId: "hook-x", reason: "config changed" });
    assert.deepEqual(__lifecycleCallsForTest("hook-x"), []);

    await __flushStageBoundaryForTest();
    const result = await pending;

    assert.equal(result.phase, "reloaded-in-turn");
    assert.deepEqual(__lifecycleCallsForTest("hook-x"), [
      "deactivate",
      "dispose",
      "init",
      "activate",
    ]);
  });

  it("defers a between-turns extension until SessionTurnEnd", async () => {
    __registerActiveExtensionForTest({ extId: "provider-x", reloadBehavior: "between-turns" });

    const result = await requestReload({ extId: "provider-x", reason: "cred changed" });

    assert.equal(result.phase, "deferred-between-turns");
    assert.deepEqual(__lifecycleCallsForTest("provider-x"), []);

    await __emitSessionTurnEndForTest();

    assert.deepEqual(__lifecycleCallsForTest("provider-x"), [
      "deactivate",
      "dispose",
      "init",
      "activate",
    ]);
  });

  it("refuses a never-reload extension", async () => {
    __registerActiveExtensionForTest({ extId: "session-store-x", reloadBehavior: "never" });

    const result = await requestReload({ extId: "session-store-x", reason: "manual" });

    assert.equal(result.phase, "refused");
    assert.deepEqual(__lifecycleCallsForTest("session-store-x"), []);
    assert.deepEqual(__auditEventsForTest(), [
      {
        code: "ExtensionReloadRefused",
        extId: "session-store-x",
        reason: "manual",
        at: result.at,
      },
    ]);
  });

  it("rolls back on init failure and marks the extension disabled", async () => {
    __registerActiveExtensionForTest({
      extId: "broken-on-init",
      reloadBehavior: "in-turn",
      lifecycle: {
        init: async () => {
          await Promise.resolve();
          throw new Error("boom");
        },
      },
    });

    const pending = requestReload({ extId: "broken-on-init", reason: "test" });
    await __flushStageBoundaryForTest();

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ExtensionHost);
      assert.equal(error.code, "LifecycleFailure");
      assert.equal(error.context["extId"], "broken-on-init");
      return true;
    });
    assert.equal(__isDisabledForTest("broken-on-init"), true);
    assert.deepEqual(__lifecycleCallsForTest("broken-on-init"), [
      "deactivate",
      "dispose",
      "init",
      "deactivate",
    ]);
  });

  it("throws Validation/ExtensionNotFound for an unknown extId", async () => {
    await assert.rejects(requestReload({ extId: "ghost", reason: "x" }), (error: unknown) => {
      assert.ok(error instanceof Validation);
      assert.equal(error.code, "ExtensionNotFound");
      assert.equal(error.context["extId"], "ghost");
      return true;
    });
  });

  it("reloads only the targeted extension, not the whole set", async () => {
    __registerActiveExtensionForTest({ extId: "hook-x", reloadBehavior: "in-turn" });
    __registerActiveExtensionForTest({ extId: "provider-x", reloadBehavior: "between-turns" });
    __registerActiveExtensionForTest({ extId: "logger-x", reloadBehavior: "in-turn" });

    const before = __snapshotLoadedSetForTest();
    const pending = requestReload({ extId: "hook-x", reason: "test" });
    await __flushStageBoundaryForTest();
    await pending;
    const after = __snapshotLoadedSetForTest();

    assert.deepEqual(diff(before, after), ["hook-x"]);
    assert.deepEqual(__lifecycleCallsForTest("provider-x"), []);
    assert.deepEqual(__lifecycleCallsForTest("logger-x"), []);
  });
});

function diff(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): string[] {
  return Object.keys(after)
    .filter((extId) => {
      const key = extId;
      return before[key] !== after[key];
    })
    .sort();
}
