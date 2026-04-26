/**
 * UAT-29: Reload-Mid-Turn respects reloadBehavior.
 *
 * Drives the real `requestReload` (`src/core/lifecycle/reloader.ts`) with
 * the three reloadBehavior values and asserts:
 *
 *   1. `in-turn` queues the reload at the next stage boundary.
 *   2. `between-turns` queues until SessionTurnEnd.
 *   3. `never` refuses the reload.
 *   4. `deactivate → dispose → init → activate` fires only on the
 *      affected extension.
 *
 * Wiki: flows/Reload-Mid-Turn.md + core/Lifecycle-Manager.md
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  requestReload,
  __emitSessionTurnEndForTest,
  __flushStageBoundaryForTest,
  __registerActiveExtensionForTest,
  __resetReloadRuntimeForTest,
} from "../../src/core/lifecycle/reloader.js";

afterEach(() => {
  __resetReloadRuntimeForTest();
});

describe("UAT-29: Reload-Mid-Turn respects reloadBehavior", () => {
  it("'in-turn' queues at stage boundary; flushing runs deactivate→dispose→init→activate", async () => {
    const calls: string[] = [];
    __registerActiveExtensionForTest({
      extId: "in-turn-ext",
      reloadBehavior: "in-turn",
      lifecycle: {
        deactivate: () => {
          calls.push("deactivate");
          return Promise.resolve();
        },
        dispose: () => {
          calls.push("dispose");
          return Promise.resolve();
        },
        init: () => {
          calls.push("init");
          return Promise.resolve();
        },
        activate: () => {
          calls.push("activate");
          return Promise.resolve();
        },
      },
    });
    const reloadPromise = requestReload({ extId: "in-turn-ext", reason: "config changed" });
    await __flushStageBoundaryForTest();
    const result = await reloadPromise;
    assert.equal(result.phase, "reloaded-in-turn");
    assert.deepEqual(calls, ["deactivate", "dispose", "init", "activate"]);
  });

  it("'between-turns' deferred — no calls until SessionTurnEnd flushes the queue", async () => {
    const calls: string[] = [];
    __registerActiveExtensionForTest({
      extId: "btx",
      reloadBehavior: "between-turns",
      lifecycle: {
        deactivate: () => {
          calls.push("deactivate");
          return Promise.resolve();
        },
        dispose: () => {
          calls.push("dispose");
          return Promise.resolve();
        },
        init: () => {
          calls.push("init");
          return Promise.resolve();
        },
        activate: () => {
          calls.push("activate");
          return Promise.resolve();
        },
      },
    });
    const r = await requestReload({ extId: "btx", reason: "x" });
    assert.equal(r.phase, "deferred-between-turns");
    assert.deepEqual(calls, []);
    await __emitSessionTurnEndForTest();
    assert.deepEqual(calls, ["deactivate", "dispose", "init", "activate"]);
  });

  it("'never' refuses the reload (phase=refused, no lifecycle calls)", async () => {
    const calls: string[] = [];
    __registerActiveExtensionForTest({
      extId: "frozen",
      reloadBehavior: "never",
      lifecycle: {
        deactivate: () => {
          calls.push("deactivate");
          return Promise.resolve();
        },
      },
    });
    const r = await requestReload({ extId: "frozen", reason: "x" });
    assert.equal(r.phase, "refused");
    assert.deepEqual(calls, []);
  });

  it("reload of an unknown extension throws Validation/ExtensionNotFound", async () => {
    let threwCode: string | undefined;
    try {
      await requestReload({ extId: "nope", reason: "x" });
    } catch (err) {
      threwCode = (err as { context?: { code?: string } }).context?.code;
    }
    assert.equal(threwCode, "ExtensionNotFound");
  });
});
