/**
 * Tests for the resume-time scan that surfaces prior-session
 * `--param` / `/params` overrides as `RuntimeParamsNotResumed`.
 *
 * Wiki: flows/Session-Resume.md § "Provider params not persisted";
 *       operations/Audit-Trail.md § "Audit records as redacted deltas".
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { scanPriorRuntimeOverrides } from "../../../src/cli/runtime/resume-params-scan.js";

let globalRoot: string;

beforeEach(async () => {
  globalRoot = await mkdtemp(join(tmpdir(), "resume-scan-"));
  await mkdir(join(globalRoot, "logs"), { recursive: true });
});

afterEach(async () => {
  await rm(globalRoot, { recursive: true, force: true });
});

async function writeAuditLog(sessionId: string, lines: readonly object[]): Promise<void> {
  const path = join(globalRoot, "logs", `session-${sessionId}.jsonl`);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

describe("scanPriorRuntimeOverrides", () => {
  it("returns empty when audit log file does not exist", async () => {
    const result = await scanPriorRuntimeOverrides(globalRoot, "nonexistent");
    assert.deepEqual(result, []);
  });

  it("returns empty when audit log is empty", async () => {
    await writeAuditLog("s1", []);
    const result = await scanPriorRuntimeOverrides(globalRoot, "s1");
    assert.deepEqual(result, []);
  });

  it("returns 'launch' override entries", async () => {
    await writeAuditLog("s1", [
      {
        type: "Params",
        payload: {
          kind: "ParamsChanged",
          paramPath: ["temperature"],
          sourceLayer: "launch",
          redactedValue: 0.9,
        },
      },
    ]);
    const result = await scanPriorRuntimeOverrides(globalRoot, "s1");
    assert.equal(result.length, 1);
    assert.equal(result[0]?.sourceLayer, "launch");
    assert.deepEqual(result[0]?.paramPath, ["temperature"]);
    assert.equal(result[0]?.redactedValue, 0.9);
  });

  it("returns '/params' override entries", async () => {
    await writeAuditLog("s1", [
      {
        type: "Params",
        payload: {
          kind: "ParamsChanged",
          paramPath: ["thinkingConfig", "thinkingLevel"],
          sourceLayer: "/params",
          redactedValue: "low",
        },
      },
    ]);
    const result = await scanPriorRuntimeOverrides(globalRoot, "s1");
    assert.equal(result.length, 1);
    assert.equal(result[0]?.sourceLayer, "/params");
    assert.deepEqual(result[0]?.paramPath, ["thinkingConfig", "thinkingLevel"]);
  });

  it("ignores 'defaultParams' source records (those re-apply automatically on resume)", async () => {
    await writeAuditLog("s1", [
      {
        type: "Params",
        payload: {
          kind: "ParamsChanged",
          paramPath: ["temperature"],
          sourceLayer: "defaultParams",
          redactedValue: 0.7,
        },
      },
      {
        type: "Params",
        payload: {
          kind: "ParamsChanged",
          paramPath: ["topP"],
          sourceLayer: "/params",
          redactedValue: 0.9,
        },
      },
    ]);
    const result = await scanPriorRuntimeOverrides(globalRoot, "s1");
    assert.equal(result.length, 1);
    assert.equal(result[0]?.sourceLayer, "/params");
  });
});

describe("scanPriorRuntimeOverrides — filtering", () => {
  it("ignores non-Params class records", async () => {
    await writeAuditLog("s1", [
      { type: "SessionStarted", payload: { storeId: "filesystem-session-store" } },
      { type: "TurnStarted", payload: { turnId: "t1", userInput: "hi" } },
    ]);
    const result = await scanPriorRuntimeOverrides(globalRoot, "s1");
    assert.deepEqual(result, []);
  });

  it("ignores records with kind other than ParamsChanged (e.g., RuntimeParamsNotResumed)", async () => {
    await writeAuditLog("s1", [
      {
        type: "Params",
        payload: {
          kind: "RuntimeParamsNotResumed",
          paramPath: ["temperature"],
          sourceLayer: "launch",
          redactedValue: 0.9,
        },
      },
    ]);
    const result = await scanPriorRuntimeOverrides(globalRoot, "s1");
    assert.deepEqual(result, []);
  });

  it("collects multiple entries in order", async () => {
    await writeAuditLog("s1", [
      {
        type: "Params",
        payload: {
          kind: "ParamsChanged",
          paramPath: ["temperature"],
          sourceLayer: "launch",
          redactedValue: 0.9,
        },
      },
      {
        type: "Params",
        payload: {
          kind: "ParamsChanged",
          paramPath: ["topP"],
          sourceLayer: "/params",
          redactedValue: 0.5,
        },
      },
    ]);
    const result = await scanPriorRuntimeOverrides(globalRoot, "s1");
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((r) => r.paramPath.join(".")),
      ["temperature", "topP"],
    );
  });

  it("skips malformed JSON lines without throwing", async () => {
    const path = join(globalRoot, "logs", "session-s1.jsonl");
    await writeFile(
      path,
      [
        "not-json",
        JSON.stringify({
          type: "Params",
          payload: {
            kind: "ParamsChanged",
            paramPath: ["topP"],
            sourceLayer: "launch",
            redactedValue: 0.9,
          },
        }),
        "{also broken",
      ].join("\n"),
      "utf8",
    );
    const result = await scanPriorRuntimeOverrides(globalRoot, "s1");
    assert.equal(result.length, 1);
    assert.equal(result[0]?.paramPath[0], "topP");
  });

  it("skips records with empty paramPath", async () => {
    await writeAuditLog("s1", [
      {
        type: "Params",
        payload: {
          kind: "ParamsChanged",
          paramPath: [],
          sourceLayer: "launch",
          redactedValue: 0.9,
        },
      },
    ]);
    const result = await scanPriorRuntimeOverrides(globalRoot, "s1");
    assert.deepEqual(result, []);
  });
});
