import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatHelp, parseLaunchArgs } from "../../src/cli/launch-args.js";
import { Validation } from "../../src/core/errors/validation.js";

const env = { cwd: () => "/tmp/project" };

describe("parseLaunchArgs", () => {
  it("parses --continue --yolo --headless together", () => {
    const args = parseLaunchArgs(["--continue", "--yolo", "--headless"], env);
    assert.equal(args.continue, true);
    assert.equal(args.yolo, true);
    assert.equal(args.headless, true);
  });

  it("defaults projectRoot to join(cwd, .stud) with no ancestor walk", () => {
    const args = parseLaunchArgs([], env);
    assert.equal(args.projectRoot, "/tmp/project/.stud");
  });

  it("accepts --mode ask | yolo | allowlist", () => {
    assert.equal(parseLaunchArgs(["--mode", "ask"], env).mode, "ask");
    assert.equal(parseLaunchArgs(["--mode", "yolo"], env).mode, "yolo");
    assert.equal(parseLaunchArgs(["--mode", "allowlist"], env).mode, "allowlist");
  });

  it("rejects --api-key with Validation/UnsupportedFlag per Q-7", () => {
    assert.throws(
      () => parseLaunchArgs(["--api-key", "sk-xxx"], env),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.class, "Validation");
        assert.equal(err.context["code"], "UnsupportedFlag");
        return true;
      },
    );
  });

  it("rejects unknown flags with Validation/UnknownFlag", () => {
    assert.throws(
      () => parseLaunchArgs(["--bogus"], env),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.class, "Validation");
        assert.equal(err.context["code"], "UnknownFlag");
        return true;
      },
    );
  });

  it("rejects --mode with an out-of-set value", () => {
    assert.throws(
      () => parseLaunchArgs(["--mode", "pretend"], env),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.class, "Validation");
        assert.equal(err.context["code"], "InvalidMode");
        return true;
      },
    );
  });

  it("rejects --sm with no value", () => {
    assert.throws(
      () => parseLaunchArgs(["--sm"], env),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.class, "Validation");
        assert.equal(err.context["code"], "ArgumentMissing");
        return true;
      },
    );
  });

  it("formatHelp lists every documented flag and omits --api-key + --project-root", () => {
    const help = formatHelp();
    assert.equal(help.includes("--continue"), true);
    assert.equal(help.includes("--headless"), true);
    assert.equal(help.includes("--yolo"), true);
    assert.equal(help.includes("--mode"), true);
    assert.equal(help.includes("--sm"), true);
    assert.equal(help.includes("--help"), true);
    assert.equal(help.includes("--api-key"), false);
    // Wiki runtime/Launch-Arguments.md drops --project-root: project root is
    // always <cwd>/.stud per safety invariant #5.
    assert.equal(help.includes("--project-root"), false);
  });

  it("rejects --project-root with Validation/UnknownFlag (wiki: project root is always <cwd>/.stud)", () => {
    assert.throws(
      () => parseLaunchArgs(["--project-root", "/tmp/foo"], env),
      (err: unknown) => {
        assert.ok(err instanceof Validation);
        assert.equal(err.class, "Validation");
        assert.equal(err.context["code"], "UnknownFlag");
        return true;
      },
    );
  });
});
