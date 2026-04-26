import assert from "node:assert/strict";
import { describe, it } from "node:test";

import main from "../../src/cli/index.js";
import { runShell } from "../../src/cli/shell.js";

import type { LaunchArgs } from "../../src/cli/launch-args.js";

function launchArgs(overrides: Partial<LaunchArgs> = {}): LaunchArgs {
  return {
    continue: false,
    headless: true,
    yolo: false,
    mode: null,
    projectRoot: "/tmp/p/.stud",
    sm: null,
    help: false,
    rawArgv: [],
    ...overrides,
  };
}

async function captureStream(
  stream: NodeJS.WriteStream,
  run: () => Promise<void>,
): Promise<string> {
  const originalWrite = stream.write.bind(stream);
  let output = "";
  stream.write = ((chunk: string | Uint8Array): boolean => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof stream.write;

  try {
    await run();
  } finally {
    stream.write = originalWrite;
  }

  return output;
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  return captureStream(process.stdout, run);
}

async function captureStderr(run: () => Promise<void>): Promise<string> {
  return captureStream(process.stderr, run);
}

function readStructuredStderr(output: string): Record<string, unknown> {
  const firstLine = output.trim().split("\n")[0] ?? "";
  if (firstLine.length === 0) {
    throw new Error("expected structured stderr output");
  }
  return JSON.parse(firstLine) as Record<string, unknown>;
}

function structuredError(payload: Record<string, unknown>): Record<string, unknown> {
  return payload["error"] as Record<string, unknown>;
}

describe("runShell (happy paths)", () => {
  it("returns exitCode 0 and prints stable help when --help is requested", async () => {
    const captured: { handle?: Awaited<ReturnType<typeof runShell>> } = {};
    const stdout = await captureStdout(async () => {
      captured.handle = await runShell(launchArgs({ help: true, rawArgv: ["--help"] }));
    });

    assert.ok(captured.handle !== undefined);
    assert.equal(captured.handle.exitCode, 0);
    assert.equal(captured.handle.session.id, null);
    assert.ok(stdout.includes("Usage: stud-cli"), `expected help text, got: ${stdout}`);
  });

  it("boots the Default TUI when no extensions override it", async () => {
    const handle = await runShell(launchArgs({ yolo: true }));

    assert.equal(handle.exitCode, 0);
    assert.equal(handle.session.id, "session-local");
  });
});

describe("runShell (error surfaces)", () => {
  it("renders Validation errors via structured output without crashing", async () => {
    let code = 0;
    const output = await captureStderr(async () => {
      code = await main(["--bogus"]);
    });

    const payload = readStructuredStderr(output);
    const error = structuredError(payload);
    assert.equal(code, 1);
    assert.equal(payload["surface"], "cli.validation-error");
    assert.equal(error["class"], "Validation");
    assert.equal(error["code"], "UnknownFlag");
  });

  it("renders an ExtensionHost startup failure through the TUI startup-error view", async () => {
    let handleExitCode = 0;
    const output = await captureStderr(async () => {
      const handle = await runShell(launchArgs({ projectRoot: "/tmp/nonexistent/.stud" }));
      handleExitCode = handle.exitCode;
    });

    const payload = readStructuredStderr(output);
    const error = structuredError(payload);
    assert.equal(handleExitCode, 1);
    assert.equal(payload["surface"], "default-tui.startup-error");
    assert.equal(error["class"], "ExtensionHost");
    assert.equal(error["code"], "StartupFailure");
  });

  it("propagates Session.ResumeMismatch through the TUI startup-error view", async () => {
    let handleExitCode = 0;
    const output = await captureStderr(async () => {
      const handle = await runShell(launchArgs({ continue: true, rawArgv: ["--continue"] }));
      handleExitCode = handle.exitCode;
    });

    const payload = readStructuredStderr(output);
    const error = structuredError(payload);
    assert.equal(handleExitCode, 1);
    assert.equal(payload["surface"], "default-tui.startup-error");
    assert.equal(error["class"], "Session");
    assert.equal(error["code"], "ResumeMismatch");
  });

  it("main() returns 0 on a clean --help path", async () => {
    const code = await main(["--help"]);
    assert.equal(code, 0);
  });
});
