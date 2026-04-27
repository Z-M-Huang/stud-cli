/**
 * CommandContract tests.
 *
 * Verifies:
 *   1. Shape — kind fixed to 'Command', both cardinalities 'unlimited',
 *              name template literal, description, execute function.
 *   2. Name validation — names starting with `/` and matching
 *      `^/[A-Za-z0-9_-]+$` are valid; others raise CommandNameInvalid.
 *   3. Description validation — empty description raises CommandDescriptionEmpty.
 *   4. execute — returns a CommandResult with a rendered string; never throws raw.
 *   5. commandConfigSchema fixtures — valid / invalid / worst-plausible via AJV.
 *   6. Conformance harness — `assertContract` returns ok:true for reference command.
 *
 * Wiki: contracts/Commands.md, core/Command-Model.md,
 *       contracts/Conformance-and-Testing.md
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import Ajv from "ajv";

import {
  commandConfigSchema,
  type CommandArgs,
  type CommandConfig,
  type CommandContract,
} from "../../src/contracts/commands.js";
import { Validation } from "../../src/core/errors/index.js";
import { assertContract } from "../helpers/contract-conformance.js";

// ---------------------------------------------------------------------------
// Reference command — fully conforming; echoes its raw args.
// ---------------------------------------------------------------------------

function makeReferenceCommand(
  overrides?: Partial<CommandContract<CommandConfig>>,
): CommandContract<CommandConfig> {
  const base: CommandContract<CommandConfig> = {
    kind: "Command",
    contractVersion: "1.0.0",
    requiredCoreVersion: ">=1.0.0 <2.0.0",
    lifecycle: {
      init: async () => {
        /* no-op */
      },
      activate: async () => {
        /* no-op */
      },
      deactivate: async () => {
        /* no-op */
      },
      dispose: async () => {
        /* no-op — idempotent by construction */
      },
    },
    configSchema: commandConfigSchema,
    loadedCardinality: "unlimited",
    activeCardinality: "unlimited",
    stateSlot: null,
    discoveryRules: { folder: "commands", manifestKey: "reference-command" },
    reloadBehavior: "in-turn",
    name: "/echo",
    description: "Echoes command arguments back to the user.",
    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async (args: CommandArgs, _host) => ({
      rendered: `echo: ${args.raw}`,
      payload: { raw: args.raw },
    }),
  };
  return { ...base, ...overrides };
}

const commandFixtures = {
  valid: { enabled: true } satisfies CommandConfig,
  invalid: { enabled: 42 },
  worstPlausible: {
    enabled: true,
    __proto__: { polluted: true },
    extra: "x".repeat(1_000_000),
  },
};

// ---------------------------------------------------------------------------
// Helper: validate a contract's name and description per the contract rules.
// Mirrors the load-time checks the core dispatcher would run.
// ---------------------------------------------------------------------------

const NAME_RE = /^\/[\w-]+$/;

function validateCommandContract(contract: {
  readonly name: `/${string}`;
  readonly description: string;
}): { ok: true } | { ok: false; error: Validation } {
  if (!NAME_RE.test(contract.name)) {
    return {
      ok: false,
      error: new Validation(
        `Command name '${contract.name}' does not match ^/[A-Za-z0-9_-]+$`,
        undefined,
        {
          code: "CommandNameInvalid",
          name: contract.name,
        },
      ),
    };
  }
  if (typeof contract.description !== "string" || contract.description.trim().length === 0) {
    return {
      ok: false,
      error: new Validation("Command description must be a non-empty string", undefined, {
        code: "CommandDescriptionEmpty",
      }),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 1. Shape — kind, cardinality, name, description, execute
// ---------------------------------------------------------------------------

describe("CommandContract shape", () => {
  it("fixes kind to 'Command'", () => {
    const contract = makeReferenceCommand();
    assert.equal(contract.kind, "Command");
  });

  it("fixes loadedCardinality to 'unlimited'", () => {
    const contract = makeReferenceCommand();
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("fixes activeCardinality to 'unlimited'", () => {
    const contract = makeReferenceCommand();
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("declares a name starting with '/'", () => {
    const contract = makeReferenceCommand();
    assert.ok(
      contract.name.startsWith("/"),
      `Expected name to start with '/', got '${contract.name}'`,
    );
  });

  it("declares a non-empty description", () => {
    const contract = makeReferenceCommand();
    assert.ok(typeof contract.description === "string" && contract.description.length > 0);
  });

  it("exposes an execute function", () => {
    const contract = makeReferenceCommand();
    assert.equal(typeof contract.execute, "function");
  });

  it("declares a valid contractVersion semver", () => {
    const contract = makeReferenceCommand();
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    const contract = makeReferenceCommand();
    assert.equal(typeof contract.requiredCoreVersion, "string");
    assert.ok(contract.requiredCoreVersion.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Name validation
// ---------------------------------------------------------------------------

describe("CommandContract name validation", () => {
  it("accepts a name matching ^/[A-Za-z0-9_-]+$", () => {
    const result = validateCommandContract(makeReferenceCommand({ name: "/echo" }));
    assert.equal(result.ok, true);
  });

  it("accepts names with hyphens and underscores", () => {
    const result = validateCommandContract(makeReferenceCommand({ name: "/my-command_v2" }));
    assert.equal(result.ok, true);
  });

  it("rejects a name without a leading '/' with CommandNameInvalid", () => {
    const contract = makeReferenceCommand({ name: "bad" as `/${string}` });
    const result = validateCommandContract(contract);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "Validation");
      assert.equal((result.error.context as Record<string, unknown>)["code"], "CommandNameInvalid");
    }
  });

  it("rejects a name containing whitespace with CommandNameInvalid", () => {
    const contract = makeReferenceCommand({ name: "/bad name" as `/${string}` });
    const result = validateCommandContract(contract);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal((result.error.context as Record<string, unknown>)["code"], "CommandNameInvalid");
    }
  });

  it("rejects a name that is only '/' with CommandNameInvalid", () => {
    const contract = makeReferenceCommand({ name: "/" as `/${string}` });
    const result = validateCommandContract(contract);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal((result.error.context as Record<string, unknown>)["code"], "CommandNameInvalid");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Description validation
// ---------------------------------------------------------------------------

describe("CommandContract description validation", () => {
  it("accepts a non-empty description", () => {
    const result = validateCommandContract(
      makeReferenceCommand({ description: "Does something." }),
    );
    assert.equal(result.ok, true);
  });

  it("rejects an empty description with CommandDescriptionEmpty", () => {
    const contract = makeReferenceCommand({ description: "" });
    const result = validateCommandContract(contract);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "Validation");
      assert.equal(
        (result.error.context as Record<string, unknown>)["code"],
        "CommandDescriptionEmpty",
      );
    }
  });

  it("rejects a whitespace-only description with CommandDescriptionEmpty", () => {
    const contract = makeReferenceCommand({ description: "   " });
    const result = validateCommandContract(contract);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        (result.error.context as Record<string, unknown>)["code"],
        "CommandDescriptionEmpty",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. execute — CommandResult shape; no raw throw
// ---------------------------------------------------------------------------

describe("CommandContract execute", () => {
  it("returns a CommandResult with a rendered string for valid args", async () => {
    const contract = makeReferenceCommand();
    const args: CommandArgs = { raw: "hello world", positional: ["hello", "world"], flags: {} };
    const result = await contract.execute(args, {} as never);
    assert.equal(typeof result.rendered, "string");
    assert.ok(result.rendered.length > 0);
  });

  it("includes the raw args in the rendered string", async () => {
    const contract = makeReferenceCommand();
    const args: CommandArgs = { raw: "test-input", positional: [], flags: {} };
    const result = await contract.execute(args, {} as never);
    assert.ok(result.rendered.includes("test-input"));
  });

  it("payload is optional — may be undefined", async () => {
    const contract = makeReferenceCommand({
      // eslint-disable-next-line @typescript-eslint/require-await
      execute: async (_args, _host) => ({ rendered: "done" }),
    });
    const result = await contract.execute({ raw: "", positional: [], flags: {} }, {} as never);
    assert.equal(typeof result.rendered, "string");
    // payload is optional; no assertion required on its presence
  });
});

// ---------------------------------------------------------------------------
// 5. commandConfigSchema — valid / invalid / worst-plausible fixtures
// ---------------------------------------------------------------------------

describe("commandConfigSchema", () => {
  // AJV v6: strip $schema before compiling.
  const { $schema: _ignored, ...compilableSchema } = commandConfigSchema as Record<string, unknown>;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(compilableSchema);

  it("accepts a valid fixture", () => {
    const result = validate(commandFixtures.valid);
    assert.equal(
      result,
      true,
      `Expected valid fixture to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it("rejects invalid fixture and provides a path containing 'enabled'", () => {
    const result = validate(commandFixtures.invalid);
    assert.equal(result, false, "Expected invalid fixture to be rejected");
    const firstError = validate.errors?.[0];
    assert.ok(firstError != null, "Expected at least one AJV error");
    // AJV v6 uses dataPath; should reference the enabled field.
    const path = (firstError as { dataPath?: string }).dataPath ?? firstError.schemaPath ?? "";
    assert.ok(
      String(path).includes("enabled"),
      `Expected rejection path to include 'enabled', got '${String(path)}'`,
    );
  });

  it("rejects worst-plausible input without AJV throwing", () => {
    let result: boolean;
    try {
      result = validate(commandFixtures.worstPlausible) as boolean;
    } catch (err) {
      assert.fail(`AJV threw on worst-plausible input: ${String(err)}`);
    }
    assert.equal(result!, false, "Expected worst-plausible fixture to be rejected");
  });

  it("accepts a valid fixture with an alias array", () => {
    const result = validate({ enabled: true, alias: ["ec", "echo-cmd"] });
    assert.equal(
      result,
      true,
      `Expected fixture with alias to pass; errors: ${JSON.stringify(validate.errors)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. assertContract conformance harness
// ---------------------------------------------------------------------------

describe("CommandContract conformance harness", () => {
  it("returns ok:true for the reference command", async () => {
    const contract = makeReferenceCommand();
    const report = await assertContract({
      contract,
      fixtures: commandFixtures,
      extId: "reference-command",
    });
    assert.equal(
      report.ok,
      true,
      `Conformance failures: ${JSON.stringify(report.failures, null, 2)}`,
    );
    assert.equal(report.shapeOk, true);
    assert.equal(report.cardinalityOk, true);
    assert.equal(report.validFixtureAccepted, true);
    assert.equal(report.invalidFixtureRejected, true);
    assert.equal(report.worstPlausibleRejectedWithoutCrash, true);
    assert.equal(report.disposeIdempotent, true);
    assert.deepEqual(report.lifecycleOrderObserved, ["init", "activate", "deactivate", "dispose"]);
  });

  it("records invalidFixtureRejectionPath containing 'enabled'", async () => {
    const report = await assertContract({
      contract: makeReferenceCommand(),
      fixtures: commandFixtures,
      extId: "reference-command",
    });
    assert.ok(
      report.invalidFixtureRejectionPath?.includes("enabled"),
      `Expected rejection path to include 'enabled', got '${report.invalidFixtureRejectionPath}'`,
    );
  });
});
