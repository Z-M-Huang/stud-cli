import { join } from "node:path";

import { Validation } from "../core/errors/validation.js";

import type { SecurityMode } from "../contracts/settings-shape.js";

export interface LaunchParam {
  /** Dot-path; e.g., `["effort"]` or `["thinkingConfig", "thinkingLevel"]`. */
  readonly path: readonly string[];
  /** Parsed JSON value (or string when JSON parse fails). */
  readonly value: unknown;
  /** Original `<path>=<value>` text for diagnostics / audit. */
  readonly raw: string;
}

export interface LaunchArgs {
  readonly continue: boolean;
  readonly headless: boolean;
  readonly yolo: boolean;
  readonly mode: SecurityMode | null;
  readonly projectRoot: string;
  readonly sm: string | null;
  /**
   * Repeatable runtime params overrides, parsed from `--param <path=value>`
   * per `wiki/runtime/Launch-Arguments.md` § "--param" and `wiki/contracts/Provider-Params.md`
   * § "Merge layers — precedence". Higher precedence than `defaultParams`;
   * NOT persisted to the session manifest.
   */
  readonly params: readonly LaunchParam[];
  readonly help: boolean;
  readonly version: boolean;
  readonly rawArgv: readonly string[];
}

const VALID_MODES = new Set<SecurityMode>(["ask", "yolo", "allowlist"]);

export function formatHelp(): string {
  return [
    "Usage: stud-cli [options]",
    "",
    "Options:",
    "  --continue                Resume the latest persisted session.",
    "  --headless                Run without an interactor; permission requests halt the turn.",
    "  --yolo                    Skip prompts in headless and tool approvals in interactive mode.",
    "  --mode <ask|yolo|allowlist>",
    "                            Set the session security mode at session start.",
    "  --sm <id>                 Attach the named state machine at session start.",
    "  --param <path=value>      Set a session-runtime provider-params override (repeatable).",
    "  --help                    Print this help and exit.",
    "  --version                 Print the current version and exit.",
    "",
    "Configure provider credentials through settings.json apiKeyRef or environment variables.",
  ].join("\n");
}

export function parseLaunchArgs(
  argv: readonly string[],
  env: { readonly cwd: () => string },
): LaunchArgs {
  let resumeLatest = false;
  let headless = false;
  let yolo = false;
  let mode: SecurityMode | null = null;
  // Project root is always <cwd>/.stud per safety invariant #5 (no walk-up,
  // no override). Wiki: runtime/Launch-Arguments.md "Flags not accepted" lists
  // --project-root as out-of-scope for v1.
  const projectRoot = join(env.cwd(), ".stud");
  let sm: string | null = null;
  const params: LaunchParam[] = [];
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    switch (arg) {
      case "--continue":
        resumeLatest = true;
        break;
      case "--headless":
        headless = true;
        break;
      case "--yolo":
        yolo = true;
        break;
      case "--help":
        help = true;
        break;
      case "--version":
        version = true;
        break;
      case "--mode": {
        const value = requireValue(argv, index, "--mode");
        if (!VALID_MODES.has(value as SecurityMode)) {
          throw new Validation(`Invalid mode '${value}'`, undefined, {
            code: "InvalidMode",
            value,
            usage: formatHelp(),
          });
        }
        mode = value as SecurityMode;
        index += 1;
        break;
      }
      case "--sm": {
        sm = requireValue(argv, index, "--sm");
        index += 1;
        break;
      }
      case "--param": {
        const raw = requireValue(argv, index, "--param");
        params.push(parseLaunchParam(raw));
        index += 1;
        break;
      }
      case "--api-key":
        throw new Validation(
          "--api-key is not supported; configure apiKeyRef in settings.json",
          undefined,
          {
            code: "UnsupportedFlag",
            flag: "--api-key",
            setting: "apiKeyRef",
            usage: formatHelp(),
          },
        );
      default:
        if (arg.startsWith("--")) {
          throw new Validation(`Unknown flag '${arg}'`, undefined, {
            code: "UnknownFlag",
            flag: arg,
            usage: formatHelp(),
          });
        }
        throw new Validation(`Unknown flag '${arg}'`, undefined, {
          code: "UnknownFlag",
          flag: arg,
          usage: formatHelp(),
        });
    }
  }

  return Object.freeze({
    continue: resumeLatest,
    headless,
    yolo,
    mode,
    projectRoot,
    sm,
    params: Object.freeze(params),
    help,
    version,
    rawArgv: Object.freeze([...argv]),
  });
}

/**
 * Parse one `--param <path=value>` entry. Path uses dot-notation
 * (e.g., `thinkingConfig.thinkingLevel`); value is JSON-decoded when parseable
 * (so `--param effort=high` → string "high", `--param topP=0.9` → number 0.9,
 * `--param thinking={"type":"adaptive"}` → object).
 *
 * Per-flag content validation (forbidden keys, secret values, wire-shape,
 * unknown keys, reserved keys) runs at settings-load / swap time so the user
 * sees the same diagnostic surface as `defaultParams` violations.
 *
 * Wiki: runtime/Launch-Arguments.md § "--param".
 */
export function parseLaunchParam(raw: string): LaunchParam {
  const eq = raw.indexOf("=");
  if (eq < 1) {
    throw new Validation(`Invalid --param '${raw}'; expected '<path=value>'`, undefined, {
      code: "InvalidParam",
      raw,
      usage: formatHelp(),
    });
  }
  const pathStr = raw.slice(0, eq);
  const valueStr = raw.slice(eq + 1);
  const path = pathStr.split(".").filter((seg) => seg.length > 0);
  if (path.length === 0) {
    throw new Validation(`Invalid --param '${raw}'; empty path`, undefined, {
      code: "InvalidParam",
      raw,
      usage: formatHelp(),
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(valueStr) as unknown;
  } catch {
    value = valueStr;
  }
  return Object.freeze({ path: Object.freeze(path), value, raw });
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Validation(`Missing value for ${flag}`, undefined, {
      code: "ArgumentMissing",
      flag,
      usage: formatHelp(),
    });
  }
  return value;
}
