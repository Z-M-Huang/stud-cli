import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contract } from "../../../../src/extensions/ui/default-tui/contract.js";
import { assertContract } from "../../../helpers/contract-conformance.js";
import { mockHost } from "../../../helpers/mock-host.js";

import type { HostAPI } from "../../../../src/core/host/host-api.js";

interface TestUIState {
  rendered: string;
  activeDialogs: readonly unknown[];
  startupHeader: string;
  startupDetails: readonly string[];
  modeDisplay: string;
}

interface StartupState {
  warnings: number;
  errors: number;
  failures: readonly { extId: string; reason: string }[];
}

interface TestHost extends HostAPI {
  readonly ui: TestUIState;
  readonly startup?: StartupState;
  readonly answeredRequests?: ReadonlySet<string>;
  readonly events: HostAPI["events"] & {
    emitTokenDelta(delta: { correlationId: string; text: string }): void;
    raiseInteraction(request: { kind: string; correlationId: string; prompt: string }): void;
  };
}

async function initAndActivate(
  host: TestHost,
  config: Record<string, unknown> = {},
): Promise<void> {
  await contract.lifecycle.init?.(host, config);
  await contract.lifecycle.activate?.(host);
}

function assertAlreadyAnswered(err: unknown): true {
  assert.equal(typeof err, "object");
  const shape = err as { class?: string; context?: Record<string, unknown> };
  assert.equal(shape.class, "Session");
  assert.equal(shape.context?.["code"], "InteractionAlreadyAnswered");
  return true;
}

function createTestHost(opts?: {
  extId?: string;
  mode?: "ask" | "yolo" | "allowlist";
  startup?: StartupState;
  answeredRequests?: ReadonlySet<string>;
}): TestHost {
  const { host } = mockHost({ extId: opts?.extId ?? "default-tui", mode: opts?.mode ?? "ask" });
  const ui: TestUIState = {
    rendered: "",
    activeDialogs: [],
    startupHeader: "",
    startupDetails: [],
    modeDisplay: "",
  };

  const augmented = {
    ...host,
    ui,
    ...(opts?.startup !== undefined ? { startup: opts.startup } : {}),
    ...(opts?.answeredRequests !== undefined ? { answeredRequests: opts.answeredRequests } : {}),
    events: {
      ...host.events,
      emitTokenDelta(delta: { correlationId: string; text: string }): void {
        host.events.emit("TokenDelta", delta);
      },
      raiseInteraction(request: { kind: string; correlationId: string; prompt: string }): void {
        host.events.emit("InteractionRaised", request);
      },
      emit(
        event: { name: string; payload: Record<string, unknown> } | string,
        payload?: unknown,
      ): void {
        if (typeof event === "string") {
          host.events.emit(event, payload);
          return;
        }
        host.events.emit(event.name, event.payload);
      },
    },
  } satisfies TestHost;

  return augmented;
}

function registerCoreContractTests(): void {
  it("declares both subscriber and interactor roles", () => {
    assert.equal(contract.kind, "UI");
    assert.equal(contract.roles.includes("subscriber"), true);
    assert.equal(contract.roles.includes("interactor"), true);
  });

  it("passes the generic contract conformance harness", async () => {
    const result = await assertContract({
      contract,
      fixtures: {
        valid: {
          enabled: true,
          theme: "auto",
          maxLogLines: 1000,
          startupViewEnabled: true,
        },
        invalid: { theme: "nope" },
        worstPlausible: { theme: "auto", extra: true, maxLogLines: -1 },
      },
      extId: "default-tui",
    });
    assert.equal(result.ok, true, `Conformance failures: ${JSON.stringify(result.failures)}`);
  });
}

function registerInteractionTests(): void {
  it("renders stream deltas in registration order", async () => {
    const host = createTestHost();
    await initAndActivate(host, { maxLogLines: 1000 });
    host.events.emitTokenDelta({ correlationId: "t1", text: "hello " });
    host.events.emitTokenDelta({ correlationId: "t1", text: "world" });
    assert.match(host.ui.rendered, /hello world/);
  });

  it("dismisses dialog on InteractionAnswered broadcast", async () => {
    const host = createTestHost();
    await initAndActivate(host);
    host.events.raiseInteraction({ kind: "Ask", correlationId: "r1", prompt: "?" });
    host.events.emit("InteractionAnswered", { correlationId: "r1" });
    assert.deepEqual(host.ui.activeDialogs, []);
  });

  it("late response yields Session/InteractionAlreadyAnswered", async () => {
    const host = createTestHost({ answeredRequests: new Set(["r1"]) });
    await contract.lifecycle.init?.(host, {});
    await assert.rejects(
      contract.respondInteraction?.("r1", { accepted: true }),
      (err: unknown) => {
        assertAlreadyAnswered(err);
        const shape = err as { context?: Record<string, unknown> };
        assert.equal(shape.context?.["requestId"], "r1");
        return true;
      },
    );
  });

  it("onInteraction resolves after respondInteraction", async () => {
    const host = createTestHost();
    await contract.lifecycle.init?.(host, {});
    const pending = contract.onInteraction?.(
      { kind: "Ask", correlationId: "r1", prompt: "?", payload: {} },
      host,
    );

    assert.ok(pending !== undefined);
    assert.equal(host.ui.activeDialogs.length, 1);

    const response = await contract.respondInteraction?.("r1", { accepted: true });
    assert.deepEqual(response, {
      correlationId: "r1",
      status: "accepted",
      value: { accepted: true },
    });
    await assert.doesNotReject(pending);
    assert.deepEqual(await pending, response);
  });

  it("marks requests answered after the first successful response", async () => {
    const host = createTestHost();
    await initAndActivate(host);
    host.events.raiseInteraction({ kind: "Ask", correlationId: "r1", prompt: "?" });

    await assert.doesNotReject(contract.respondInteraction?.("r1", { accepted: true }));
    await assert.rejects(
      contract.respondInteraction?.("r1", { accepted: true }),
      assertAlreadyAnswered,
    );
  });
}

function registerLifecycleAndSurfaceTests(): void {
  it("mode display is read-only (no setMode call)", async () => {
    const host = createTestHost({ mode: "ask" });
    await contract.lifecycle.init?.(host, {});
    const keys = contract.keyboardShortcuts?.() ?? [];
    assert.equal(keys.find((key) => key.binding === "Ctrl-M")?.action, "show-mode");
    assert.equal(
      keys.find((key) => key.action === ("set-mode" as never)),
      undefined,
    );
    assert.equal(host.ui.modeDisplay, "Mode: ask");
  });

  it("startup view lists failed plugins with counts", async () => {
    const host = createTestHost({
      startup: { warnings: 2, errors: 1, failures: [{ extId: "bad-ext", reason: "config" }] },
    });
    await contract.lifecycle.init?.(host, { startupViewEnabled: true });
    assert.equal(host.ui.startupHeader, "2 warnings, 1 errors");
    assert.deepEqual(host.ui.startupDetails, ["bad-ext: config"]);
  });

  it("refuses cross-extension stateSlot access (AC-115)", async () => {
    const host = createTestHost({ extId: "default-tui" });
    await contract.lifecycle.init?.(host, {});
    assert.throws(() => host.session.stateSlot("other-ext"), /ExtensionHost/);
  });

  it("dispose is idempotent", async () => {
    const host = createTestHost();
    await contract.lifecycle.dispose?.(host);
    await contract.lifecycle.dispose?.(host);
  });
}

describe("default TUI", () => {
  registerCoreContractTests();
  registerInteractionTests();
  registerLifecycleAndSurfaceTests();
});
