import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dispatchCommand } from "../../../src/core/commands/dispatcher.js";
import { resolveByScope } from "../../../src/core/commands/scope.js";
import { ExtensionHost, Validation } from "../../../src/core/errors/index.js";
import { fakeHost } from "../../helpers/host-fixtures.js";

import type { CommandRegistration } from "../../../src/core/commands/dispatcher.js";

const reg = (
  name: string,
  scope: "bundled" | "global" | "project",
  id: string,
): CommandRegistration => ({
  name,
  scope,
  extensionId: id,
  execute: () => Promise.resolve(),
});

describe("resolveByScope", () => {
  it("project wins over global wins over bundled", () => {
    const bundled = reg("/r", "bundled", "b");
    const globalRegistration = reg("/r", "global", "g");
    const project = reg("/r", "project", "p");

    const result = resolveByScope("/r", [bundled, globalRegistration, project]);

    assert.equal(result.resolved?.extensionId, "p");
  });

  it("same-scope duplicates produce candidates with no winner", () => {
    const a = reg("/x", "global", "a");
    const b = reg("/x", "global", "b");

    const result = resolveByScope("/x", [a, b]);

    assert.equal(result.resolved, undefined);
    assert.equal(result.candidates?.length, 2);
  });
});

describe("dispatchCommand validation", () => {
  it("unknown name → Validation/CommandUnknown", async () => {
    await assert.rejects(
      dispatchCommand({
        line: "/nope",
        registrations: [],
        host: fakeHost(),
        turnState: { active: false },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.class, "Validation");
        assert.equal(error.context["code"], "CommandUnknown");
        return true;
      },
    );
  });

  it("ambiguous same-scope → Validation/CommandAmbiguous", async () => {
    const a = reg("/x", "global", "a");
    const b = reg("/x", "global", "b");

    await assert.rejects(
      dispatchCommand({
        line: "/x",
        registrations: [a, b],
        host: fakeHost(),
        turnState: { active: false },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.class, "Validation");
        assert.equal(error.context["code"], "CommandAmbiguous");
        assert.deepEqual(error.context["candidates"], [a, b]);
        return true;
      },
    );
  });

  it("invalid line (missing leading /) → Validation/CommandNameInvalid", async () => {
    await assert.rejects(
      dispatchCommand({
        line: "echo",
        registrations: [],
        host: fakeHost(),
        turnState: { active: false },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.class, "Validation");
        assert.equal(error.context["code"], "CommandNameInvalid");
        return true;
      },
    );
  });

  it("invalid line with control characters → Validation/CommandNameInvalid", async () => {
    await assert.rejects(
      dispatchCommand({
        line: "/echo\u0007",
        registrations: [reg("/echo", "bundled", "e")],
        host: fakeHost(),
        turnState: { active: false },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "CommandNameInvalid");
        return true;
      },
    );
  });

  it("invalid line with C1 control characters → Validation/CommandNameInvalid", async () => {
    await assert.rejects(
      dispatchCommand({
        line: "/echo\u0090",
        registrations: [reg("/echo", "bundled", "e")],
        host: fakeHost(),
        turnState: { active: false },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "CommandNameInvalid");
        return true;
      },
    );
  });
});

describe("dispatchCommand execution", () => {
  it("dispatched calls execute with args and host", async () => {
    const calls: { args: readonly string[]; host: unknown }[] = [];
    const registration: CommandRegistration = {
      name: "/echo",
      scope: "bundled",
      extensionId: "e",
      execute: (args, host) => {
        calls.push({ args, host });
        return Promise.resolve();
      },
    };
    const host = fakeHost();

    const outcome = await dispatchCommand({
      line: "/echo hello world",
      registrations: [registration],
      host,
      turnState: { active: false },
    });

    assert.equal(outcome.kind, "dispatched");
    assert.deepEqual(calls[0]?.args, ["hello", "world"]);
    assert.equal(calls[0]?.host, host);
  });

  it("mid-turn interaction attempt is blocked", async () => {
    let executed = false;
    const registration: CommandRegistration = {
      name: "/prompt",
      scope: "bundled",
      extensionId: "e",
      execute: async (_args, host) => {
        executed = true;
        await host.interaction.raise({ kind: "confirm", prompt: "continue?" });
      },
    };

    const outcome = await dispatchCommand({
      line: "/prompt",
      registrations: [registration],
      host: fakeHost(),
      turnState: { active: true },
    });

    assert.equal(executed, false);
    assert.equal(outcome.kind, "out-of-turn-blocked");
  });

  it("rethrows ExtensionHost errors from execute unchanged", async () => {
    const extensionError = new ExtensionHost("boom", undefined, {
      code: "AlreadyWrapped",
    });
    const registration: CommandRegistration = {
      name: "/wrapped",
      scope: "bundled",
      extensionId: "e",
      execute: () => Promise.reject(extensionError),
    };

    await assert.rejects(
      dispatchCommand({
        line: "/wrapped",
        registrations: [registration],
        host: fakeHost(),
        turnState: { active: false },
      }),
      (error: unknown) => {
        assert.equal(error, extensionError);
        return true;
      },
    );
  });

  it("wraps unknown execute errors as ExtensionHost/CommandExecFailed", async () => {
    const registration: CommandRegistration = {
      name: "/explode",
      scope: "bundled",
      extensionId: "e",
      execute: () => Promise.reject(new Error("boom")),
    };

    await assert.rejects(
      dispatchCommand({
        line: "/explode",
        registrations: [registration],
        host: fakeHost(),
        turnState: { active: false },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ExtensionHost);
        assert.equal(error.class, "ExtensionHost");
        assert.equal(error.context["code"], "CommandExecFailed");
        assert.equal(error.context["extensionId"], "e");
        return true;
      },
    );
  });
});
