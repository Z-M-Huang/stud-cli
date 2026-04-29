import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runShell } from "../../src/cli/shell.js";

import type { LaunchArgs } from "../../src/cli/launch-args.js";
import type { PromptIO } from "../../src/cli/prompt.js";

class RecordingPrompt implements PromptIO {
  readonly selectPrompts: string[] = [];
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
    prompt: string,
    _options: readonly { readonly value: T; readonly label: string }[],
  ): Promise<T> {
    this.selectPrompts.push(prompt);
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

function sseResponse(events: readonly string[]): string {
  return events.map((event) => `data: ${event}\n\n`).join("") + "data: [DONE]\n\n";
}

async function seedTrustedOpenAICompatibleProject(
  home: string,
  projectRoot: string,
): Promise<void> {
  await mkdir(join(home, ".stud"), { recursive: true });
  await mkdir(join(projectRoot, "..", "src"), { recursive: true });
  await writeFile(join(projectRoot, "..", "README.md"), "Tool approval workspace\n", "utf8");
  await writeFile(join(projectRoot, "..", "src", "index.ts"), "export const value = 1;\n", "utf8");
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

function installGlobFetchMock(): () => void {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (() => {
    calls += 1;
    if (calls === 1) {
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
                        id: "call_glob_root",
                        function: {
                          name: "glob",
                          arguments: JSON.stringify({ pattern: "**/*.ts", path: "." }),
                        },
                      },
                      {
                        index: 1,
                        id: "call_glob_src",
                        function: {
                          name: "glob",
                          arguments: JSON.stringify({ pattern: "**/*.ts", path: "src" }),
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
          JSON.stringify({ choices: [{ delta: { content: "Found the TypeScript files." } }] }),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
  }) as unknown as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function installReadFetchMock(getProjectRoot: () => string): () => void {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (() => {
    calls += 1;
    if (calls === 1) {
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
                        id: "call_read_root",
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
          JSON.stringify({ choices: [{ delta: { content: "Read the project README." } }] }),
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
  }) as unknown as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function installBashAliasFetchMock(): () => void {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (() => {
    calls += 1;
    if (calls === 1) {
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
                        id: "call_bash_pwd",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({ cmd: "pwd" }),
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
        sseResponse([JSON.stringify({ choices: [{ delta: { content: "Bash executed." } }] })]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
  }) as unknown as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe("tool approval cache", () => {
  it("reuses a remembered directory approval for descendant paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "stud-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "stud-project-"));
    const projectRoot = join(cwd, ".stud");
    const restoreFetch = installGlobFetchMock();
    await mkdir(projectRoot, { recursive: true });

    try {
      await seedTrustedOpenAICompatibleProject(home, projectRoot);
      const prompt = new RecordingPrompt({
        selectAnswers: ["approve"],
        inputAnswers: ["inspect files", "/exit"],
      });
      const stdout = await captureStdout(async () => {
        await runShell(launchArgs({ headless: false, projectRoot }), {
          homedir: () => home,
          prompt,
          sessionIdFactory: () => "session-approval",
        });
      });

      assert.deepEqual(prompt.selectPrompts, ["Allow tool 'glob' for '.'?"]);
      assert.equal(stdout.includes("assistant error"), false);
      assert.equal(stdout.match(/^ {2}tool glob[^\n]+running$/gmu)?.length, 2);
    } finally {
      restoreFetch();
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows read without prompting", async () => {
    const home = await mkdtemp(join(tmpdir(), "stud-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "stud-project-"));
    const projectRoot = join(cwd, ".stud");
    const restoreFetch = installReadFetchMock(() => projectRoot);
    await mkdir(projectRoot, { recursive: true });

    try {
      await seedTrustedOpenAICompatibleProject(home, projectRoot);
      const prompt = new RecordingPrompt({
        inputAnswers: ["inspect readme", "/exit"],
      });
      const stdout = await captureStdout(async () => {
        await runShell(launchArgs({ headless: false, projectRoot }), {
          homedir: () => home,
          prompt,
          sessionIdFactory: () => "session-read-approval",
        });
      });

      assert.deepEqual(prompt.selectPrompts, []);
      assert.equal(stdout.includes("assistant error"), false);
      assert.equal(stdout.match(/^ {2}tool read[^\n]+running$/gmu)?.length, 1);
    } finally {
      restoreFetch();
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("accepts common bash command aliases before schema validation", async () => {
    const home = await mkdtemp(join(tmpdir(), "stud-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "stud-project-"));
    const projectRoot = join(cwd, ".stud");
    const restoreFetch = installBashAliasFetchMock();
    await mkdir(projectRoot, { recursive: true });

    try {
      await seedTrustedOpenAICompatibleProject(home, projectRoot);
      const prompt = new RecordingPrompt({
        selectAnswers: ["approve"],
        inputAnswers: ["check cwd", "/exit"],
      });
      const stdout = await captureStdout(async () => {
        await runShell(launchArgs({ headless: false, projectRoot }), {
          homedir: () => home,
          prompt,
          sessionIdFactory: () => "session-bash-alias",
        });
      });

      assert.deepEqual(prompt.selectPrompts, ["Allow tool 'bash' for 'pwd'?"]);
      assert.equal(stdout.includes("assistant error"), false);
      assert.equal(stdout.match(/^ {2}tool bash[^\n]+running$/gmu)?.length, 1);
      assert.equal(stdout.includes("Bash executed."), true);
    } finally {
      restoreFetch();
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
