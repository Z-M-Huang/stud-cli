import { join } from "node:path";

import { Validation } from "../core/errors/validation.js";

import type { SecurityMode } from "../contracts/settings-shape.js";

export interface LaunchArgs {
  readonly continue: boolean;
  readonly headless: boolean;
  readonly yolo: boolean;
  readonly mode: SecurityMode | null;
  readonly projectRoot: string;
  readonly sm: string | null;
  readonly help: boolean;
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
    "  --help                    Print this help and exit.",
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
  let help = false;

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
    help,
    rawArgv: Object.freeze([...argv]),
  });
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
