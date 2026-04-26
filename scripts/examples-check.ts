/**
 * Examples parity check (UAT-38, AC-118).
 *
 * Three responsibilities:
 *
 *  1. Every official extension category has at least one example directory
 *     under `examples/<category>/`. A category with no subdirectories (or
 *     only an underscore-prefixed shared dir) reports as missing.
 *
 *  2. Every reference extension at `src/extensions/<category>/<id>/` has a
 *     companion `examples/<category>/<id>/` directory.
 *
 *  3. Any `config.json` found under `examples/<category>/<id>/` validates
 *     against the matching category configSchema from `src/contracts/`.
 *     Examples that ship `example.json` (extension-specific config samples)
 *     are NOT validated here — that is the extension's per-config schema's
 *     responsibility, not the category meta-schema.
 *
 * The CLI exits 1 if the report is non-empty, naming the offending paths.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

import { commandConfigSchema } from "../src/contracts/commands.js";
import { contextProviderConfigSchema } from "../src/contracts/context-providers.js";
import { hookConfigSchema } from "../src/contracts/hooks.js";
import { loggerConfigSchema } from "../src/contracts/loggers.js";
import { providerConfigSchema } from "../src/contracts/providers.js";
import { sessionStoreConfigSchema } from "../src/contracts/session-store.js";
import { smConfigSchema } from "../src/contracts/state-machines.js";
import { toolConfigSchema } from "../src/contracts/tools.js";
import { uiConfigSchema } from "../src/contracts/ui.js";

import type { JSONSchemaObject } from "../src/contracts/state-slot.js";

export interface ExamplesCheckReport {
  readonly categoriesMissingExamples: readonly string[];
  readonly referenceExtsWithoutExamples: readonly {
    readonly category: string;
    readonly extId: string;
  }[];
  readonly schemaViolations: readonly {
    readonly category: string;
    readonly extId: string;
    readonly path: string;
    readonly message: string;
  }[];
}

const CATEGORIES = [
  "providers",
  "tools",
  "hooks",
  "ui",
  "loggers",
  "state-machines",
  "commands",
  "session-stores",
  "context-providers",
] as const;

type Category = (typeof CATEGORIES)[number];

const CATEGORY_SCHEMAS: Readonly<Record<Category, JSONSchemaObject>> = {
  providers: providerConfigSchema,
  tools: toolConfigSchema,
  hooks: hookConfigSchema,
  ui: uiConfigSchema,
  loggers: loggerConfigSchema,
  "state-machines": smConfigSchema,
  commands: commandConfigSchema,
  "session-stores": sessionStoreConfigSchema,
  "context-providers": contextProviderConfigSchema,
};

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function listSubdirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function isUserFacing(name: string): boolean {
  // Skip underscore-prefixed dirs (shared/adapter helpers) when counting
  // category coverage — they are not standalone examples a user would copy.
  return !name.startsWith("_");
}

async function validateConfigJson(
  category: Category,
  extId: string,
  cfgPath: string,
  ajv: InstanceType<typeof Ajv>,
  out: { category: string; extId: string; path: string; message: string }[],
): Promise<void> {
  let text: string;
  try {
    text = await readFile(cfgPath, "utf8");
  } catch (err) {
    out.push({
      category,
      extId,
      path: cfgPath,
      message: `failed to read config.json: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    out.push({
      category,
      extId,
      path: cfgPath,
      message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  // Drop the `$schema` URL — ajv 6 only ships draft-07 metaschema, but our
  // schemas reference draft-2020-12. The keywords we use are draft-07-safe.
  const { $schema: _drop, ...schema } = CATEGORY_SCHEMAS[category] as Record<string, unknown>;
  void _drop;
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    for (const err of validate.errors ?? []) {
      out.push({
        category,
        extId,
        path: err.dataPath !== undefined && err.dataPath.length > 0 ? err.dataPath : "/",
        message: err.message ?? "schema mismatch",
      });
    }
  }
}

export async function runExamplesCheck(opts: {
  readonly repoRoot: string;
}): Promise<ExamplesCheckReport> {
  const { repoRoot } = opts;
  const categoriesMissingExamples: string[] = [];
  const referenceExtsWithoutExamples: { category: string; extId: string }[] = [];
  const schemaViolations: { category: string; extId: string; path: string; message: string }[] = [];

  // Ajv 6.x: schemas may use draft 2020-12 keywords we don't enforce here.
  const ajv = new Ajv({ allErrors: true });

  for (const category of CATEGORIES) {
    const exDir = join(repoRoot, "examples", category);
    if (!(await dirExists(exDir))) {
      categoriesMissingExamples.push(category);
      continue;
    }
    const allSubdirs = await listSubdirs(exDir);
    const userFacing = allSubdirs.filter(isUserFacing);
    if (userFacing.length === 0) {
      categoriesMissingExamples.push(category);
    }

    for (const extId of allSubdirs) {
      const cfgPath = join(exDir, extId, "config.json");
      if (await fileExists(cfgPath)) {
        await validateConfigJson(category, extId, cfgPath, ajv, schemaViolations);
      }
    }
  }

  const extensionsDir = join(repoRoot, "src", "extensions");
  const extCategories = await listSubdirs(extensionsDir);
  for (const category of extCategories) {
    if (!CATEGORIES.includes(category as Category)) continue;
    const catDir = join(extensionsDir, category);
    const extIds = (await listSubdirs(catDir)).filter(isUserFacing);
    for (const extId of extIds) {
      const examplesPath = join(repoRoot, "examples", category, extId);
      if (!(await dirExists(examplesPath))) {
        referenceExtsWithoutExamples.push({ category, extId });
      }
    }
  }

  return {
    categoriesMissingExamples,
    referenceExtsWithoutExamples,
    schemaViolations,
  };
}

export async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const report = await runExamplesCheck({ repoRoot });
  const issueCount =
    report.categoriesMissingExamples.length +
    report.referenceExtsWithoutExamples.length +
    report.schemaViolations.length;

  if (issueCount === 0) {
    process.stdout.write("Examples check: clean\n");
    return;
  }

  for (const cat of report.categoriesMissingExamples) {
    process.stderr.write(
      `MISSING category example: examples/${cat}/ (no user-facing example subdir)\n`,
    );
  }
  for (const m of report.referenceExtsWithoutExamples) {
    process.stderr.write(
      `MISSING companion example: examples/${m.category}/${m.extId}/ ` +
        `(extension src/extensions/${m.category}/${m.extId}/ has no example)\n`,
    );
  }
  for (const v of report.schemaViolations) {
    process.stderr.write(
      `SCHEMA VIOLATION: examples/${v.category}/${v.extId}/config.json ` +
        `at ${v.path}: ${v.message}\n`,
    );
  }
  process.stderr.write(
    `\nExamples check failed: ${issueCount} issue(s) ` +
      `(${report.categoriesMissingExamples.length} missing categories, ` +
      `${report.referenceExtsWithoutExamples.length} missing companions, ` +
      `${report.schemaViolations.length} schema violations)\n`,
  );
  process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  await main();
}
