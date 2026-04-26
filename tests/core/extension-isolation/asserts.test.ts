import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

interface ExtensionIsolationModule {
  readonly assertNoSandboxClaim: (
    rootDir: string,
    options?: {
      readonly includeGlobs?: readonly string[];
      readonly excludeGlobs?: readonly string[];
    },
  ) => Promise<{
    readonly ok: boolean;
    readonly violations: readonly {
      readonly kind: "no-sandbox-claim";
      readonly path: string;
      readonly line: number;
      readonly match: string;
    }[];
  }>;
  readonly BANNED_SANDBOX_TERMS: readonly string[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtures = path.join(__dirname, "fixtures");
const moduleUrl = new URL("../../../src/core/extension-isolation/asserts.ts", import.meta.url);
const { assertNoSandboxClaim, BANNED_SANDBOX_TERMS } = (await import(
  moduleUrl.href
)) as ExtensionIsolationModule;

describe("assertNoSandboxClaim", () => {
  it("passes on a clean source tree", async () => {
    const result = await assertNoSandboxClaim(path.join(fixtures, "clean"));

    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
  });

  it('flags a "sandbox" claim in source', async () => {
    const result = await assertNoSandboxClaim(path.join(fixtures, "with-sandbox-claim"));

    assert.equal(result.ok, false);
    assert.equal(result.violations.length >= 1, true);
    assert.equal(result.violations[0]?.match.toLowerCase().includes("sandbox"), true);
  });

  it('flags a "safe mode" claim in a comment', async () => {
    const result = await assertNoSandboxClaim(path.join(fixtures, "with-safe-mode-comment"));

    assert.equal(result.ok, false);
    assert.equal(
      result.violations.some((violation) => violation.match.toLowerCase().includes("safe mode")),
      true,
    );
  });

  it("does not scan tests/ or scripts/ by default", async () => {
    const result = await assertNoSandboxClaim(path.join(fixtures, "with-test-only-mention"));

    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
  });

  it("BANNED_SANDBOX_TERMS is a non-empty readonly list of banned literals", () => {
    assert.equal(BANNED_SANDBOX_TERMS.length > 0, true);
    assert.equal(BANNED_SANDBOX_TERMS.includes("sandbox"), true);
  });

  it("applied to the live src/ tree under the repo, returns ok: true", async () => {
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const result = await assertNoSandboxClaim(repoRoot);

    assert.equal(
      result.ok,
      true,
      `expected live src/ scan to be clean, got ${JSON.stringify(result.violations, null, 2)}`,
    );
    assert.equal(result.violations.length, 0);
  });

  it("supports explicit include/exclude globs outside the default src/ tree", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "extension-isolation-"));

    try {
      await mkdir(path.join(rootDir, "notes"), { recursive: true });
      await writeFile(
        path.join(rootDir, "notes", "example.ts"),
        'export const note = "sandbox";\n',
      );
      await writeFile(
        path.join(rootDir, "notes", "ignored.ts"),
        'export const ignored = "sandbox";\n',
      );

      const result = await assertNoSandboxClaim(rootDir, {
        includeGlobs: ["notes/**/*.ts"],
        excludeGlobs: ["notes/ignored.ts"],
      });

      assert.equal(result.ok, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0]?.path, path.join(rootDir, "notes", "example.ts"));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("returns ok:false with no violations when file collection fails", async () => {
    const rootDir = path.join(tmpdir(), `extension-isolation-missing-${Date.now()}`);
    const result = await assertNoSandboxClaim(rootDir, {
      includeGlobs: ["**/*.ts"],
      excludeGlobs: [],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.violations, []);
  });
});
