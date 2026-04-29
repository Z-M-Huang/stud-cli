import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import main from "../../src/cli/index.js";
import { runShell } from "../../src/cli/shell.js";

import type { LaunchArgs } from "../../src/cli/launch-args.js";
import type { PromptIO } from "../../src/cli/prompt.js";

class ScriptedPrompt implements PromptIO {
  private selectAnswers: string[];
  private inputAnswers: string[];
  constructor(options: {
    readonly selectAnswers?: readonly string[];
    readonly inputAnswers?: readonly string[];
  }) {
    this.selectAnswers = [...(options.selectAnswers ?? [])];
    this.inputAnswers = [...(options.inputAnswers ?? [])];
  }
  select<T extends string>(
    _prompt: string,
    _options: readonly { readonly value: T; readonly label: string }[],
  ): Promise<T> {
    const next = this.selectAnswers.shift();
    if (next === undefined) {
      throw new Error("missing scripted select answer");
    }
    return Promise.resolve(next as T);
  }
  input(_prompt: string): Promise<string> {
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
function launchArgs(overrides: Partial<LaunchArgs> = {}): LaunchArgs {
  return {
    continue: false,
    headless: true,
    yolo: false,
    mode: null,
    projectRoot: "/tmp/p/.stud",
    sm: null,
    help: false,
    version: false,
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
const captureStdout = (run: () => Promise<void>): Promise<string> =>
  captureStream(process.stdout, run);
const captureStderr = (run: () => Promise<void>): Promise<string> =>
  captureStream(process.stderr, run);
function sseResponse(events: readonly string[]): string {
  return events.map((event) => `data: ${event}\n\n`).join("") + "data: [DONE]\n\n";
}
function readStructuredStderr(output: string): Record<string, unknown> {
  const firstLine = output.trim().split("\n")[0] ?? "";
  if (firstLine.length === 0) {
    throw new Error("expected structured stderr output");
  }
  return JSON.parse(firstLine) as Record<string, unknown>;
}
const structuredError = (payload: Record<string, unknown>): Record<string, unknown> =>
  payload["error"] as Record<string, unknown>;
async function withTempProject(
  run: (paths: { readonly home: string; readonly projectRoot: string }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "stud-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "stud-project-"));
  const projectRoot = join(cwd, ".stud");
  await mkdir(projectRoot, { recursive: true });
  try {
    await run({ home, projectRoot });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "stud-home-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
interface CapturedOpenAIRequest {
  readonly url: string;
  readonly body: Readonly<Record<string, unknown>>;
}
async function seedTrustedOpenAICompatibleProject(
  home: string,
  projectRoot: string,
): Promise<void> {
  await mkdir(join(home, ".stud"), { recursive: true });
  await writeFile(join(projectRoot, "..", "README.md"), "Tool-enabled workspace\n", "utf8");
  await writeFile(
    join(home, ".stud", "settings.json"),
    JSON.stringify({
      active: { provider: "openai-compatible" },
      providers: {
        "openai-compatible": {
          apiKeyRef: { kind: "keyring", name: "test-key" },
          baseURL: "https://api.openai.com/v1",
          model: "gpt-5.4",
          apiShape: "chat-completions",
        },
      },
    }),
  );
  await writeFile(
    join(home, ".stud", "secrets.json"),
    JSON.stringify({ entries: { "test-key": "secret" } }),
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
function installReadToolFetchMock(getProjectRoot: () => string): {
  readonly calls: CapturedOpenAIRequest[];
  readonly restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const calls: CapturedOpenAIRequest[] = [];
  globalThis.fetch = ((input, init) => {
    const body = typeof init?.body === "string" ? init.body : "{}";
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      body: JSON.parse(body) as Readonly<Record<string, unknown>>,
    });

    if (calls.length === 1) {
      return Promise.resolve(
        new Response(
          sseResponse([
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_readme",
                        function: {
                          name: "read",
                          arguments: JSON.stringify({
                            file_path: join(getProjectRoot(), "..", "README.md"),
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            JSON.stringify({ choices: [{ finish_reason: "tool_calls" }] }),
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    }

    return Promise.resolve(
      new Response(
        sseResponse([
          JSON.stringify({
            choices: [{ delta: { content: "This project is a CLI workspace test." } }],
          }),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
  }) as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}
describe("runShell (basic paths)", () => {
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

  it("prints the injected package version when --version is requested", async () => {
    const captured: { handle?: Awaited<ReturnType<typeof runShell>> } = {};
    const stdout = await captureStdout(async () => {
      captured.handle = await runShell(launchArgs({ version: true }), {
        packageVersion: "9.9.9",
      });
    });
    assert.ok(captured.handle !== undefined);
    assert.equal(captured.handle.exitCode, 0);
    assert.equal(captured.handle.session.id, null);
    assert.equal(stdout.trim(), "9.9.9");
  });
});

describe("runShell (bootstrap setup)", () => {
  it("runs first-run provider setup and project trust before starting a session", async () => {
    await withTempProject(async ({ home, projectRoot }) => {
      const prompt = new ScriptedPrompt({
        selectAnswers: ["cli-wrapper", "none", "trust"],
        inputAnswers: ["/usr/bin/echo"],
      });
      let started:
        | {
            readonly providerId: string;
            readonly modelId: string;
            readonly projectTrusted: boolean;
          }
        | undefined;

      const handle = await runShell(launchArgs({ headless: false, projectRoot }), {
        homedir: () => home,
        prompt,
        sessionIdFactory: () => "session-1",
        runSession: (session) => {
          started = {
            providerId: session.provider.providerId,
            modelId: session.provider.modelId,
            projectTrusted: session.projectTrusted,
          };
          return Promise.resolve();
        },
      });
      assert.equal(handle.exitCode, 0);
      assert.equal(handle.session.id, "session-1");
      assert.deepEqual(started, {
        providerId: "cli-wrapper",
        modelId: "reference-model",
        projectTrusted: true,
      });

      const settings = JSON.parse(
        await readFile(join(home, ".stud", "settings.json"), "utf8"),
      ) as Record<string, unknown>;
      const active = settings["active"] as Record<string, unknown>;
      const providers = settings["providers"] as Record<string, Record<string, unknown>>;
      assert.equal(active["provider"], "cli-wrapper");
      assert.equal(providers["cli-wrapper"]?.["timeoutMs"], 10_000);

      const trust = JSON.parse(await readFile(join(home, ".stud", "trust.json"), "utf8")) as {
        entries: readonly { path?: string; canonicalPath?: string; decision: string }[];
      };
      assert.equal(trust.entries.length, 1);
      assert.equal(trust.entries[0]?.decision, "trusted");
      assert.equal(trust.entries[0]?.canonicalPath ?? trust.entries[0]?.path, projectRoot);
    });
  });
  it("records a declined trust decision and still starts with global scope only", async () => {
    await withTempProject(async ({ home, projectRoot }) => {
      const prompt = new ScriptedPrompt({
        selectAnswers: ["cli-wrapper", "none", "decline"],
        inputAnswers: ["/usr/bin/echo"],
      });
      let started = false;
      const handle = await runShell(launchArgs({ headless: false, projectRoot }), {
        homedir: () => home,
        prompt,
        sessionIdFactory: () => "session-2",
        runSession: () => {
          started = true;
          return Promise.resolve();
        },
      });
      assert.equal(handle.exitCode, 0);
      assert.equal(started, true);

      const trust = JSON.parse(await readFile(join(home, ".stud", "trust.json"), "utf8")) as {
        entries: readonly { decision: string }[];
      };
      assert.equal(trust.entries.at(-1)?.decision, "declined");
    });
  });
});

describe("runShell (bootstrap session)", () => {
  it("renders assistant output in the minimal session UI", async () => {
    await withTempProject(async ({ home, projectRoot }) => {
      const prompt = new ScriptedPrompt({
        selectAnswers: ["cli-wrapper", "none", "trust"],
        inputAnswers: ["/usr/bin/echo", "hi", "/exit"],
      });
      const stdout = await captureStdout(async () => {
        await runShell(launchArgs({ headless: false, projectRoot }), {
          homedir: () => home,
          prompt,
          sessionIdFactory: () => "session-ui",
        });
      });
      assert.equal(stdout.includes("stud-cli"), true);
      assert.equal(stdout.includes("assistant\n"), true);
      assert.equal(stdout.includes("stud-cli:"), true);
    });
  });
  it("exposes bundled tools and continues after a tool result", async () => {
    let projectRootForToolTest = "";
    const fetchMock = installReadToolFetchMock(() => projectRootForToolTest);
    try {
      await withTempProject(async ({ home, projectRoot }) => {
        projectRootForToolTest = projectRoot;
        await seedTrustedOpenAICompatibleProject(home, projectRoot);
        const prompt = new ScriptedPrompt({
          selectAnswers: ["approve"],
          inputAnswers: ["what is this project about", "/exit"],
        });
        const stdout = await captureStdout(async () => {
          await runShell(launchArgs({ headless: false, projectRoot }), {
            homedir: () => home,
            prompt,
            sessionIdFactory: () => "session-tools",
          });
        });
        assert.equal(stdout.includes("assistant\n  [tool call] read"), true);
        assert.match(stdout, /^ {2}tool read[^\n]+running$/mu);
        assert.equal(stdout.includes("This project is a CLI workspace test."), true);
      });
    } finally {
      fetchMock.restore();
    }

    const firstRequestTools = (fetchMock.calls[0]?.body["tools"] ?? []) as readonly Record<
      string,
      unknown
    >[];
    assert.equal(firstRequestTools.length > 0, true);
    const toolNames = firstRequestTools.map(
      (tool) => ((tool["function"] ?? {}) as Record<string, unknown>)["name"],
    );
    assert.equal(toolNames.includes("bash"), true);
    assert.equal(toolNames.includes("read"), true);

    const secondRequestMessages = (fetchMock.calls[1]?.body["messages"] ?? []) as readonly Record<
      string,
      unknown
    >[];
    const toolMessage = secondRequestMessages.find((message) => message["role"] === "tool");
    assert.ok(toolMessage !== undefined);
    assert.equal(String(toolMessage["content"]).includes("Tool-enabled workspace"), true);
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
      const handle = await runShell(
        launchArgs({ headless: true, projectRoot: "/tmp/nonexistent/.stud" }),
        {
          homedir: () => "/tmp/stud-cli-shell-test",
        },
      );
      handleExitCode = handle.exitCode;
    });
    const payload = readStructuredStderr(output);
    const error = structuredError(payload);
    assert.equal(handleExitCode, 1);
    assert.equal(payload["surface"], "default-tui.startup-error");
    assert.equal(error["class"], "Validation");
    assert.equal(error["code"], "MissingHeadlessDefaults");
  });

  it("propagates Session.ResumeMismatch through the TUI startup-error view", async () => {
    let handleExitCode = 0;
    let output = "";
    await withTempHome(async (home) => {
      output = await captureStderr(async () => {
        const handle = await runShell(launchArgs({ continue: true, rawArgv: ["--continue"] }), {
          homedir: () => home,
        });
        handleExitCode = handle.exitCode;
      });
    });
    const payload = readStructuredStderr(output);
    const error = structuredError(payload);
    assert.equal(handleExitCode, 1);
    assert.equal(payload["surface"], "default-tui.startup-error");
    assert.equal(error["class"], "Session");
    assert.equal(error["code"], "ResumeMismatch");
  });
});

describe("runShell (provider error surfaces)", () => {
  it("surfaces turn-time provider errors with an OpenAI-compatible /v1 hint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("404 page not found", { status: 404 }),
      )) as unknown as typeof fetch;

    try {
      await withTempHome(async (home) => {
        await mkdir(join(home, ".stud"), { recursive: true });
        await writeFile(
          join(home, ".stud", "settings.json"),
          JSON.stringify({
            active: { provider: "openai-compatible" },
            providers: {
              "openai-compatible": {
                apiKeyRef: { kind: "keyring", name: "test-key" },
                baseURL: "http://127.0.0.1:8317",
                model: "gpt-5.4",
                apiShape: "chat-completions",
              },
            },
          }),
        );
        await writeFile(
          join(home, ".stud", "secrets.json"),
          JSON.stringify({ entries: { "test-key": "secret" } }),
        );

        const prompt = new ScriptedPrompt({ inputAnswers: ["hi", "/exit"] });
        const stdout = await captureStdout(async () => {
          await runShell(
            launchArgs({ headless: false, projectRoot: join(home, "missing", ".stud") }),
            {
              homedir: () => home,
              prompt,
              sessionIdFactory: () => "session-error",
            },
          );
        });

        assert.equal(stdout.includes("assistant error [ProviderTransient/EndpointNotFound]"), true);
        assert.equal(stdout.includes("set baseURL to 'http://127.0.0.1:8317/v1'"), true);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it("main() returns 0 on a clean --help path", async () => {
    let code = 0;
    await captureStdout(async () => {
      code = await main(["--help"]);
    });
    assert.equal(code, 0);
  });
});
