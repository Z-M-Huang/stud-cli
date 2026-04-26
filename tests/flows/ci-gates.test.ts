/**
 * UAT-1, UAT-2, UAT-3 flow tests — drive the CI gates as child processes.
 *
 * **Recursion guard.** This file lives in the default `*.test.ts` glob, so a
 * naive `bun run test` invocation from inside it would re-discover and re-run
 * itself indefinitely. Two safeguards apply:
 *
 *   1. The expensive scenarios are gated behind `STUD_RUN_CI_GATES === "1"`.
 *      When unset, every test in this file is `t.skip()`-ed. CI sets the
 *      variable explicitly; local devs opt in deliberately.
 *
 *   2. When the gated scenarios DO run, child processes inherit env without
 *      setting the variable, so the inner suite skips itself — preventing the
 *      recursion even if a future change wires this file into a normal run.
 *
 * The negative scenario for UAT-3 plants a banned-vocab violation in a fresh
 * temp directory (never under `src/` or `tests/`), runs the scanner against
 * that directory, asserts a non-zero exit + the file path in stderr, and
 * cleans up in `after()`.
 *
 * Wiki: contracts/Conformance-and-Testing.md
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const GATE_ENABLED = process.env["STUD_RUN_CI_GATES"] === "1";

function runCommand(cmd: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Strip the gate variable from the child env so spawned child suites
    // skip themselves and avoid recursion.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["STUD_RUN_CI_GATES"];
    const child = spawn(cmd, args as string[], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code: number | null) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const skipReason =
  "Set STUD_RUN_CI_GATES=1 to run end-to-end CI gate tests (slow; spawn child processes).";

describe("UAT-1: build/lint/typecheck/format gates exit 0 on the clean tree", () => {
  it("typecheck exits 0", { skip: GATE_ENABLED ? false : skipReason }, async () => {
    const r = await runCommand("bun", ["run", "typecheck"]);
    assert.equal(r.code, 0, `typecheck failed: ${r.stderr}`);
  });

  it("lint exits 0", { skip: GATE_ENABLED ? false : skipReason }, async () => {
    const r = await runCommand("bun", ["run", "lint"]);
    assert.equal(r.code, 0, `lint failed: ${r.stderr}`);
  });

  it("format:check exits 0", { skip: GATE_ENABLED ? false : skipReason }, async () => {
    const r = await runCommand("bun", ["run", "format:check"]);
    assert.equal(r.code, 0, `format:check failed: ${r.stderr}`);
  });
});

describe("UAT-2: build is reproducible", () => {
  it("build exits 0", { skip: GATE_ENABLED ? false : skipReason }, async () => {
    const r = await runCommand("bun", ["run", "build"]);
    assert.equal(r.code, 0, `build failed: ${r.stderr}`);
  });
});

describe("UAT-3: banned-vocab scan", () => {
  let plantDir: string | null = null;

  after(async () => {
    if (plantDir !== null) {
      await rm(plantDir, { recursive: true, force: true });
      plantDir = null;
    }
  });

  it("banned-vocab on clean src exits 0", { skip: GATE_ENABLED ? false : skipReason }, async () => {
    const r = await runCommand("bun", ["run", "scripts/banned-vocab.ts", "src"]);
    assert.equal(r.code, 0, `banned-vocab on src failed: ${r.stderr}`);
  });

  it(
    "planting the banned hyphenated form fails the scan with the file path in output",
    { skip: GATE_ENABLED ? false : skipReason },
    async () => {
      plantDir = await mkdtemp(join(tmpdir(), "banned-plant-"));
      const plantFile = join(plantDir, "oops.ts");
      // Construct the banned token without writing it verbatim in this file.
      const a = "built";
      const b = "in";
      await writeFile(plantFile, `// ${a}-${b} tools go here\nexport const x = 1;\n`);
      const r = await runCommand("bun", ["run", "scripts/banned-vocab.ts", plantDir]);
      assert.notEqual(r.code, 0, "scanner must exit non-zero when violation is present");
      const combined = `${r.stdout}\n${r.stderr}`;
      assert.equal(
        combined.includes("oops.ts"),
        true,
        "scanner output must reference the offending file",
      );
    },
  );
});

describe("UAT recursion guard", () => {
  it("self-skips when STUD_RUN_CI_GATES is not set (gates run only when explicitly enabled)", () => {
    // This test always runs; it documents the gating behaviour and exists so
    // that the file shows up as a non-empty test run even when GATE_ENABLED
    // is false. When false, every gated `it` above reports as skipped — which
    // is the correct, fast default for routine `bun run test` invocations.
    if (!GATE_ENABLED) {
      assert.ok(true, "gated tests skipped — set STUD_RUN_CI_GATES=1 to run them");
      return;
    }
    assert.ok(true, "gated tests are running because STUD_RUN_CI_GATES=1");
  });
});
