import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { runShell } from "../../src/cli/shell.js";

import type { LaunchArgs } from "../../src/cli/launch-args.js";
import type { PromptIO } from "../../src/cli/prompt.js";

class ScriptedPrompt implements PromptIO {
  private inputAnswers: string[];

  constructor(inputAnswers: readonly string[]) {
    this.inputAnswers = [...inputAnswers];
  }

  select<T extends string>(): Promise<T> {
    throw new Error("unexpected select prompt");
  }

  input(): Promise<string> {
    const next = this.inputAnswers.shift();
    if (next === undefined) {
      throw new Error("missing scripted input answer");
    }
    return Promise.resolve(next);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function launchArgs(projectRoot: string, overrides: Partial<LaunchArgs> = {}): LaunchArgs {
  return {
    continue: false,
    headless: false,
    yolo: false,
    mode: null,
    projectRoot,
    sm: null,
    help: false,
    version: false,
    rawArgv: [],
    ...overrides,
  };
}

async function withWorkspace(
  run: (paths: { readonly home: string; readonly projectRoot: string }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "stud-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "stud-project-"));
  const projectRoot = join(cwd, ".stud");
  await mkdir(projectRoot, { recursive: true });
  try {
    await seedCliWrapper(home, projectRoot);
    await run({ home, projectRoot });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

async function seedCliWrapper(home: string, projectRoot: string): Promise<void> {
  await mkdir(join(home, ".stud"), { recursive: true });
  await writeFile(
    join(home, ".stud", "settings.json"),
    JSON.stringify({
      active: { provider: "cli-wrapper" },
      providers: {
        "cli-wrapper": {
          cliRef: { kind: "executable", path: "/usr/bin/echo" },
          argsTemplate: ["reply:", "{messages}"],
          timeoutMs: 10_000,
        },
      },
    }),
  );
  await writeFile(
    join(home, ".stud", "trust.json"),
    JSON.stringify({
      entries: [
        {
          canonicalPath: projectRoot,
          decision: "trusted",
          grantedAt: "2026-04-27T00:00:00.000Z",
          schemaVersion: 1,
        },
      ],
    }),
  );
}

async function readPersistedManifest(
  home: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(home, ".stud", "sessions", sessionId, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

describe("CLI filesystem session persistence", () => {
  it("writes a wiki-shaped session manifest under ~/.stud/sessions/<sessionId>", async () => {
    await withWorkspace(async ({ home, projectRoot }) => {
      await runShell(launchArgs(projectRoot), {
        homedir: () => home,
        prompt: new ScriptedPrompt(["hello", "/exit"]),
        sessionIdFactory: () => "session-one",
      });

      const manifest = await readPersistedManifest(home, "session-one");
      assert.equal(manifest["sessionId"], "session-one");
      assert.equal(manifest["projectRoot"], projectRoot);
      assert.equal(manifest["mode"], "ask");
      assert.equal(manifest["storeId"], "filesystem-session-store");
      assert.equal(Array.isArray(manifest["messages"]), true);
      assert.equal((manifest["messages"] as readonly unknown[]).length, 2);
    });
  });

  it("--continue resumes the latest manifest and appends new turns", async () => {
    await withWorkspace(async ({ home, projectRoot }) => {
      await runShell(launchArgs(projectRoot), {
        homedir: () => home,
        prompt: new ScriptedPrompt(["first", "/exit"]),
        sessionIdFactory: () => "session-resume",
      });

      const handle = await runShell(launchArgs(projectRoot, { continue: true }), {
        homedir: () => home,
        prompt: new ScriptedPrompt(["second", "/exit"]),
        sessionIdFactory: () => "unused-new-id",
      });

      const manifest = await readPersistedManifest(home, "session-resume");
      const contents = (manifest["messages"] as readonly Record<string, unknown>[]).map((message) =>
        String(message["content"]),
      );
      assert.equal(handle.session.id, "session-resume");
      assert.equal(
        contents.some((content) => content.includes("first")),
        true,
      );
      assert.equal(
        contents.some((content) => content.includes("second")),
        true,
      );
    });
  });

  it("--headless consumes stdin once and persists the completed turn", async () => {
    await withWorkspace(async ({ home, projectRoot }) => {
      const handle = await runShell(launchArgs(projectRoot, { headless: true }), {
        homedir: () => home,
        stdin: Readable.from(["headless hello"]),
        sessionIdFactory: () => "session-headless",
      });

      const manifest = await readPersistedManifest(home, "session-headless");
      const contents = (manifest["messages"] as readonly Record<string, unknown>[]).map((message) =>
        String(message["content"]),
      );
      assert.equal(handle.exitCode, 0);
      assert.equal(
        contents.some((content) => content.includes("headless hello")),
        true,
      );
    });
  });
});

describe("CLI runtime slash commands", () => {
  it("handles /health locally without sending a model turn", async () => {
    await withWorkspace(async ({ home, projectRoot }) => {
      const stdout = await captureStdout(async () => {
        await runShell(launchArgs(projectRoot), {
          homedir: () => home,
          prompt: new ScriptedPrompt(["/health", "/exit"]),
          sessionIdFactory: () => "session-health",
        });
      });

      const manifest = await readPersistedManifest(home, "session-health");
      assert.equal(stdout.includes("session: session-health"), true);
      assert.equal(stdout.includes("provider: cli-wrapper"), true);
      assert.equal((manifest["messages"] as readonly unknown[]).length, 0);
    });
  });

  it("lists all default agentool runtime tools except task tools", async () => {
    await withWorkspace(async ({ home, projectRoot }) => {
      const stdout = await captureStdout(async () => {
        await runShell(launchArgs(projectRoot), {
          homedir: () => home,
          prompt: new ScriptedPrompt(["/tools", "/exit"]),
          sessionIdFactory: () => "session-tools",
        });
      });

      for (const expected of [
        "ask-user",
        "bash",
        "diff",
        "edit",
        "glob",
        "grep",
        "http-request",
        "lsp",
        "memory",
        "multi-edit",
        "read",
        "sleep",
        "tool-search",
        "web-fetch",
        "web-search",
        "write",
      ]) {
        assert.equal(stdout.includes(`${expected}\t`), true, `${expected} should be listed`);
      }
      assert.equal(stdout.includes("task-create"), false);
      assert.equal(stdout.includes("task-get"), false);
      assert.equal(stdout.includes("task-list"), false);
      assert.equal(stdout.includes("task-update"), false);
      assert.equal(stdout.includes("read\tdefault-allowed"), true);
    });
  });

  it("/save-and-close persists and exits the session loop", async () => {
    await withWorkspace(async ({ home, projectRoot }) => {
      const stdout = await captureStdout(async () => {
        await runShell(launchArgs(projectRoot), {
          homedir: () => home,
          prompt: new ScriptedPrompt(["/save-and-close"]),
          sessionIdFactory: () => "session-save-close",
        });
      });

      const manifest = await readPersistedManifest(home, "session-save-close");
      assert.equal(stdout.includes("session saved"), true);
      assert.equal(manifest["sessionId"], "session-save-close");
    });
  });
});
