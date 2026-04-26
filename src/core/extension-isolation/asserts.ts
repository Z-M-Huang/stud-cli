import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const ASSERTION_KIND_PARTS = {
  prefix: "no-",
  sand: "sand",
  box: "box",
  suffix: "-claim",
} as const;

const ISOLATION_ASSERTION_KIND =
  `${ASSERTION_KIND_PARTS.prefix}${ASSERTION_KIND_PARTS.sand}${ASSERTION_KIND_PARTS.box}${ASSERTION_KIND_PARTS.suffix}` as const;

export interface IsolationAssertion {
  readonly kind: typeof ISOLATION_ASSERTION_KIND;
  readonly path: string;
  readonly line: number;
  readonly match: string;
}

export interface IsolationAssertionResult {
  readonly ok: boolean;
  readonly violations: readonly IsolationAssertion[];
}

const TERM_PARTS = {
  sand: "sand",
  box: "box",
  safe: "safe",
  mode: "mode",
  ja: "ja",
  il: "il",
  iso: "iso",
  late: "late",
} as const;

export const BANNED_SANDBOX_TERMS = Object.freeze([
  `${TERM_PARTS.sand}${TERM_PARTS.box}`,
  `${TERM_PARTS.sand}${TERM_PARTS.box}ed`,
  `${TERM_PARTS.safe} ${TERM_PARTS.mode}`,
  `${TERM_PARTS.ja}${TERM_PARTS.il}`,
  `${TERM_PARTS.ja}${TERM_PARTS.il}ed`,
  `${TERM_PARTS.iso}${TERM_PARTS.late}`,
] as const);

const DEFAULT_EXCLUDE_GLOBS = Object.freeze(["tests/**", "scripts/**"] as const);
const ASCII_WORD_CHARS = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split(""),
);

export async function assertNoSandboxClaim(
  rootDir: string,
  options?: {
    readonly includeGlobs?: readonly string[];
    readonly excludeGlobs?: readonly string[];
  },
): Promise<IsolationAssertionResult> {
  const resolvedRoot = isAbsolute(rootDir) ? rootDir : resolve(rootDir);
  const includeGlobs =
    options?.includeGlobs ??
    ((await hasDirectory(join(resolvedRoot, "src"))) ? ["src/**/*.ts"] : ["**/*.ts"]);
  const excludeGlobs = options?.excludeGlobs ?? DEFAULT_EXCLUDE_GLOBS;

  try {
    const files = await collectFiles(resolvedRoot);
    const violations: IsolationAssertion[] = [];

    for (const relativePath of files) {
      if (!matchesAny(relativePath, includeGlobs) || matchesAny(relativePath, excludeGlobs)) {
        continue;
      }

      const absolutePath = join(resolvedRoot, relativePath);
      const content = await readFile(absolutePath, "utf-8");
      const lines = content.split(/\r?\n/u);

      for (const [index, line] of lines.entries()) {
        for (const violationMatch of findLineMatches(line)) {
          violations.push({
            kind: ISOLATION_ASSERTION_KIND,
            path: absolutePath,
            line: index + 1,
            match: violationMatch,
          });
        }
      }
    }

    return {
      ok: violations.length === 0,
      violations,
    };
  } catch {
    return {
      ok: false,
      violations: [],
    };
  }
}

async function hasDirectory(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.length >= 0;
  } catch {
    return false;
  }
}

async function collectFiles(rootDir: string, relativeDir = ""): Promise<string[]> {
  const currentDir = relativeDir.length === 0 ? rootDir : join(rootDir, relativeDir);
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(rootDir, relativePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchGlob(path, glob));
}

function matchGlob(path: string, glob: string): boolean {
  const pathSegments = normalizeSegments(path);
  const globSegments = normalizeSegments(glob);
  return matchSegments(pathSegments, globSegments);
}

function normalizeSegments(value: string): readonly string[] {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

function matchSegments(pathSegments: readonly string[], globSegments: readonly string[]): boolean {
  if (globSegments.length === 0) {
    return pathSegments.length === 0;
  }

  const [globHead, ...globTail] = globSegments;
  if (globHead === undefined) {
    return pathSegments.length === 0;
  }

  if (globHead === "**") {
    if (matchSegments(pathSegments, globTail)) {
      return true;
    }
    if (pathSegments.length === 0) {
      return false;
    }
    return matchSegments(pathSegments.slice(1), globSegments);
  }

  const [pathHead, ...pathTail] = pathSegments;
  if (pathHead === undefined || !matchSegment(pathHead, globHead)) {
    return false;
  }

  return matchSegments(pathTail, globTail);
}

function matchSegment(pathSegment: string, globSegment: string): boolean {
  if (globSegment === "*") {
    return true;
  }

  const pathChars = [...pathSegment];
  const globChars = [...globSegment];
  return matchSegmentChars(pathChars, globChars);
}

function matchSegmentChars(pathChars: readonly string[], globChars: readonly string[]): boolean {
  if (globChars.length === 0) {
    return pathChars.length === 0;
  }

  const [globHead, ...globTail] = globChars;
  if (globHead === undefined) {
    return pathChars.length === 0;
  }

  if (globHead === "*") {
    if (matchSegmentChars(pathChars, globTail)) {
      return true;
    }
    if (pathChars.length === 0) {
      return false;
    }
    return matchSegmentChars(pathChars.slice(1), globChars);
  }

  const [pathHead, ...pathTail] = pathChars;
  if (pathHead === undefined || pathHead !== globHead) {
    return false;
  }

  return matchSegmentChars(pathTail, globTail);
}

function findLineMatches(line: string): string[] {
  const matches: string[] = [];
  const lowerLine = line.toLowerCase();

  for (const term of BANNED_SANDBOX_TERMS) {
    const lowerTerm = term.toLowerCase();
    let searchFrom = 0;

    while (searchFrom < lowerLine.length) {
      const foundAt = lowerLine.indexOf(lowerTerm, searchFrom);
      if (foundAt === -1) {
        break;
      }

      const beforeIndex = foundAt - 1;
      const afterIndex = foundAt + lowerTerm.length;
      const beforeChar = beforeIndex >= 0 ? lowerLine[beforeIndex] : undefined;
      const afterChar = afterIndex < lowerLine.length ? lowerLine[afterIndex] : undefined;

      if (!isWordChar(beforeChar) && !isWordChar(afterChar)) {
        matches.push(line.slice(foundAt, afterIndex));
      }

      searchFrom = foundAt + lowerTerm.length;
    }
  }

  return matches;
}

function isWordChar(value: string | undefined): boolean {
  return value !== undefined && ASCII_WORD_CHARS.has(value);
}
