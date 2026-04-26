/**
 * Contract conformance tests for the /help bundled command.
 *
 * Covers: shape, alphabetical listing, category grouping, empty registry,
 * idempotent dispose, and lifecycle ordering.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contract } from "../../../../../src/extensions/commands/bundled/help/index.js";
import { injectCommandsProvider } from "../../../../../src/extensions/commands/bundled/help/lifecycle.js";
import { mockHost } from "../../../../helpers/mock-host.js";

import type { CommandArgs } from "../../../../../src/contracts/commands.js";
import type { CommandEntry } from "../../../../../src/extensions/commands/bundled/help/format.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal valid CommandArgs for a bare /help invocation (no args). */
const EMPTY_ARGS: CommandArgs = { raw: "", positional: [], flags: {} };

// ---------------------------------------------------------------------------
// Shape / contract declaration tests
// ---------------------------------------------------------------------------

describe("/help command — shape", () => {
  it("declares Command category", () => {
    assert.equal(contract.kind, "Command");
  });

  it("declares name /help", () => {
    assert.equal(contract.name, "/help");
  });

  it("declares a semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("has no state slot (stateless command)", () => {
    assert.equal(contract.stateSlot, null);
  });

  it("has loadedCardinality unlimited", () => {
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("has activeCardinality unlimited", () => {
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("has a non-empty description", () => {
    assert.ok(typeof contract.description === "string" && contract.description.length > 0);
  });

  it("has a parseable configSchema", () => {
    assert.equal(typeof contract.configSchema, "object");
    assert.equal((contract.configSchema as { type?: string }).type, "object");
  });
});

// ---------------------------------------------------------------------------
// Listing behavior tests
// ---------------------------------------------------------------------------

describe("/help command — listing", () => {
  it("lists every loaded command with name + description + source extId", async () => {
    const { host } = mockHost({ extId: "help" });
    const commands: readonly CommandEntry[] = [
      { name: "/help", extId: "help", description: "List commands" },
      { name: "/mode", extId: "mode", description: "Show current mode" },
    ];

    await contract.lifecycle.init!(host, {});
    injectCommandsProvider(host, () => commands);

    const result = await contract.execute(EMPTY_ARGS, host);

    assert.ok(result.rendered.includes("/help"), "rendered must include /help");
    assert.ok(result.rendered.includes("/mode"), "rendered must include /mode");
    assert.ok(
      result.rendered.includes("Show current mode"),
      "rendered must include description text",
    );
    assert.ok(result.rendered.includes("mode"), "rendered must include source extId");
  });

  it("returns a non-empty message when no commands are loaded", async () => {
    const { host } = mockHost({ extId: "help" });
    await contract.lifecycle.init!(host, {});

    const result = await contract.execute(EMPTY_ARGS, host);

    assert.ok(typeof result.rendered === "string" && result.rendered.length > 0);
  });

  it("sorts entries alphabetically by default (groupByCategory omitted)", async () => {
    const { host } = mockHost({ extId: "help" });
    const commands: readonly CommandEntry[] = [
      { name: "/mode", extId: "mode", description: "d" },
      { name: "/help", extId: "help", description: "d" },
    ];

    await contract.lifecycle.init!(host, {});
    injectCommandsProvider(host, () => commands);

    const result = await contract.execute(EMPTY_ARGS, host);

    const helpPos = result.rendered.indexOf("/help");
    const modePos = result.rendered.indexOf("/mode");
    assert.ok(helpPos !== -1 && modePos !== -1, "both command names must appear");
    assert.ok(helpPos < modePos, "/help (a) must appear before /mode (m) alphabetically");
  });
});

// ---------------------------------------------------------------------------
// Grouping behavior tests
// ---------------------------------------------------------------------------

describe("/help command — grouping", () => {
  it("groups by category when groupByCategory is true", async () => {
    const { host } = mockHost({ extId: "help" });
    const commands: readonly CommandEntry[] = [
      { name: "/help", extId: "help", description: "d", category: "info" },
      { name: "/save-and-close", extId: "sc", description: "d", category: "session" },
    ];

    await contract.lifecycle.init!(host, { groupByCategory: true });
    injectCommandsProvider(host, () => commands);

    const result = await contract.execute(EMPTY_ARGS, host);

    const infoPos = result.rendered.indexOf("info");
    const sessionPos = result.rendered.indexOf("session");
    assert.ok(infoPos !== -1, "output must include 'info' category header");
    assert.ok(sessionPos !== -1, "output must include 'session' category header");
    assert.ok(
      infoPos < sessionPos,
      "'info' must appear before 'session' (alphabetical category order)",
    );
  });

  it("lists alphabetically when groupByCategory is false", async () => {
    const { host } = mockHost({ extId: "help" });
    const commands: readonly CommandEntry[] = [
      { name: "/save-and-close", extId: "sc", description: "d", category: "session" },
      { name: "/help", extId: "help", description: "d", category: "info" },
    ];

    await contract.lifecycle.init!(host, { groupByCategory: false });
    injectCommandsProvider(host, () => commands);

    const result = await contract.execute(EMPTY_ARGS, host);

    const helpPos = result.rendered.indexOf("/help");
    const savePos = result.rendered.indexOf("/save-and-close");
    assert.ok(helpPos < savePos, "/help must appear before /save-and-close alphabetically");
  });

  it("places entries without category in the uncategorized bucket when grouped", async () => {
    const { host } = mockHost({ extId: "help" });
    const commands: readonly CommandEntry[] = [{ name: "/help", extId: "help", description: "d" }];

    await contract.lifecycle.init!(host, { groupByCategory: true });
    injectCommandsProvider(host, () => commands);

    const result = await contract.execute(EMPTY_ARGS, host);

    assert.ok(
      result.rendered.includes("uncategorized"),
      "entries without a category must appear under 'uncategorized'",
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle and safety tests
// ---------------------------------------------------------------------------

describe("/help command — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "help" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs lifecycle in order without error", async () => {
    const { host } = mockHost({ extId: "help" });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });

  it("throws ExtensionHost/LifecycleFailure when execute is called without init", async () => {
    const { host } = mockHost({ extId: "help" });

    await assert.rejects(
      () => contract.execute(EMPTY_ARGS, host),
      (err: unknown) => {
        assert.ok(typeof err === "object" && err !== null);
        assert.equal((err as { class?: unknown }).class, "ExtensionHost");
        assert.equal((err as { context?: { code?: unknown } }).context?.code, "LifecycleFailure");
        return true;
      },
    );
  });
});
