/**
 * Contract conformance tests for the bash reference tool (AC-95).
 *
 * Covers: shape, prefix extraction (deriveApprovalKey), non-zero-exit partial
 * result, policy-block before approval, timeout killing the subprocess,
 * empty-input rejection, and output truncation.
 *
 * Uses node:test + node:assert/strict (project canonical test runner).
 * Subprocess tests use real processes (node/sh) for mechanical correctness.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contract, deriveCommandPrefix } from "../../../../src/extensions/tools/bash/index.js";
import { mockHost } from "../../../helpers/mock-host.js";

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

describe("bash tool — shape", () => {
  it("declares Tool category", () => {
    assert.equal(contract.kind, "Tool");
  });

  it("registers under manifestKey 'bash'", () => {
    assert.equal(contract.discoveryRules.manifestKey, "bash");
  });

  it("is gated by the approval stack", () => {
    assert.equal(contract.gated, true);
  });

  it("declares a semver contractVersion", () => {
    assert.match(contract.contractVersion, /^\d+\.\d+\.\d+$/);
  });

  it("declares a non-empty requiredCoreVersion range", () => {
    assert.ok(contract.requiredCoreVersion.length > 0);
  });

  it("has no state slot (stateless tool)", () => {
    assert.equal(contract.stateSlot, null);
  });

  it("loadedCardinality is unlimited", () => {
    assert.equal(contract.loadedCardinality, "unlimited");
  });

  it("activeCardinality is unlimited", () => {
    assert.equal(contract.activeCardinality, "unlimited");
  });

  it("exposes inputSchema and outputSchema as objects", () => {
    assert.equal(typeof contract.inputSchema, "object");
    assert.equal(typeof contract.outputSchema, "object");
  });
});

// ---------------------------------------------------------------------------
// Command prefix extraction — deriveApprovalKey (AC-95, Q-8 resolution)
// ---------------------------------------------------------------------------

describe("bash tool — deriveApprovalKey (prefix extraction)", () => {
  it("extracts the first token as the approval key", () => {
    assert.equal(contract.deriveApprovalKey({ command: "git status" }), "git");
    assert.equal(contract.deriveApprovalKey({ command: "rm -rf /tmp/x" }), "rm");
    assert.equal(contract.deriveApprovalKey({ command: "npm test" }), "npm");
  });

  it("skips leading env-var assignments (FOO=1 git → git)", () => {
    assert.equal(contract.deriveApprovalKey({ command: "FOO=1 npm test" }), "npm");
    assert.equal(deriveCommandPrefix("GIT_AUTHOR=x git commit"), "git");
    assert.equal(deriveCommandPrefix("FOO=bar BAZ=qux ls"), "ls");
  });

  it("skips leading redirections (2>/dev/null cmd → cmd)", () => {
    assert.equal(deriveCommandPrefix("2>/dev/null git status"), "git");
    assert.equal(deriveCommandPrefix(">/dev/null ls"), "ls");
  });

  it("returns empty string for empty or whitespace-only command", () => {
    assert.equal(deriveCommandPrefix(""), "");
    assert.equal(deriveCommandPrefix("   "), "");
  });
});

// ---------------------------------------------------------------------------
// Execute — happy path
// ---------------------------------------------------------------------------

describe("bash tool — execute success", () => {
  it("runs a command and returns stdout with exitCode 0", async () => {
    const { host } = mockHost({ extId: "bash" });
    await contract.lifecycle.init!(host, {});
    const signal = new AbortController().signal;

    const result = await contract.execute({ command: "echo hello" }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.value.stdout.includes("hello"));
      assert.equal(result.value.exitCode, 0);
    }
    await contract.lifecycle.dispose!(host);
  });

  it("non-zero exit is a partial result — not a terminal error (AC-95)", async () => {
    const { host } = mockHost({ extId: "bash" });
    await contract.lifecycle.init!(host, {});
    const signal = new AbortController().signal;

    const result = await contract.execute({ command: 'node -e "process.exit(42)"' }, host, signal);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.exitCode, 42);
      assert.equal(result.value.stdout, "");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("captures stderr output alongside stdout", async () => {
    const { host } = mockHost({ extId: "bash" });
    await contract.lifecycle.init!(host, {});
    const signal = new AbortController().signal;

    const result = await contract.execute(
      { command: "node -e \"process.stderr.write('err-output')\"" },
      host,
      signal,
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.value.stderr.includes("err-output"));
      assert.equal(result.value.exitCode, 0);
    }
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Execute — error paths
// ---------------------------------------------------------------------------

describe("bash tool — execute error paths", () => {
  it("empty command → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "bash" });
    await contract.lifecycle.init!(host, {});
    const signal = new AbortController().signal;

    const result = await contract.execute({ command: "" }, host, signal);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "InputInvalid");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("null-byte in command → ToolTerminal/InputInvalid", async () => {
    const { host } = mockHost({ extId: "bash" });
    await contract.lifecycle.init!(host, {});
    const signal = new AbortController().signal;

    const result = await contract.execute({ command: "echo\x00hello" }, host, signal);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "InputInvalid");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("policy-blocked prefix → ToolTerminal/CommandRejected (before any approval)", async () => {
    const { host } = mockHost({ extId: "bash" });
    await contract.lifecycle.init!(host, { blockedPrefixes: ["sudo"] });
    const signal = new AbortController().signal;

    const result = await contract.execute({ command: "sudo rm -rf /" }, host, signal);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTerminal");
      assert.equal(result.error.context["code"], "CommandRejected");
      assert.equal(result.error.context["prefix"], "sudo");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("multiple blocked prefixes: non-blocked command is not rejected", async () => {
    const { host } = mockHost({ extId: "bash" });
    await contract.lifecycle.init!(host, { blockedPrefixes: ["sudo", "rm"] });
    const signal = new AbortController().signal;

    // git is not blocked
    const result = await contract.execute({ command: "git --version" }, host, signal);

    assert.equal(result.ok, true);
    await contract.lifecycle.dispose!(host);
  });

  it("timeout → ToolTransient/ExecutionTimeout (subprocess is killed)", async () => {
    const { host } = mockHost({ extId: "bash" });
    await contract.lifecycle.init!(host, { defaultTimeoutMs: 80 });
    const signal = new AbortController().signal;

    const result = await contract.execute(
      { command: 'node -e "setInterval(()=>{},99999)"' },
      host,
      signal,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.class, "ToolTransient");
      assert.equal(result.error.context["code"], "ExecutionTimeout");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("per-call timeoutMs overrides config default", async () => {
    const { host } = mockHost({ extId: "bash" });
    // Config timeout is generous; per-call is tight
    await contract.lifecycle.init!(host, { defaultTimeoutMs: 30000 });
    const signal = new AbortController().signal;

    const result = await contract.execute(
      { command: 'node -e "setInterval(()=>{},99999)"', timeoutMs: 80 },
      host,
      signal,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.context["code"], "ExecutionTimeout");
    }
    await contract.lifecycle.dispose!(host);
  });

  it("output bytes capped with truncation sentinel (AC-95)", async () => {
    const { host } = mockHost({ extId: "bash" });
    await contract.lifecycle.init!(host, { maxOutputBytes: 1024 });
    const signal = new AbortController().signal;

    const result = await contract.execute(
      { command: "node -e \"process.stdout.write('x'.repeat(100000))\"" },
      host,
      signal,
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.value.stdout.length <= 1100);
      assert.ok(result.value.stdout.includes("[truncated]"));
    }
    await contract.lifecycle.dispose!(host);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("bash tool — lifecycle", () => {
  it("dispose is idempotent", async () => {
    const { host } = mockHost({ extId: "bash" });
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });

  it("runs init then dispose without error", async () => {
    const { host } = mockHost({ extId: "bash" });
    const order: string[] = [];

    await contract.lifecycle.init!(host, {});
    order.push("init");
    await contract.lifecycle.dispose!(host);
    order.push("dispose");

    assert.deepEqual(order, ["init", "dispose"]);
  });

  it("dispose after dispose does not throw", async () => {
    const { host } = mockHost({ extId: "bash" });
    await contract.lifecycle.init!(host, {});
    await contract.lifecycle.dispose!(host);
    await contract.lifecycle.dispose!(host);
  });
});
