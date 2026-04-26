import { fallbackErrorShape } from "./error-utils.js";
import { parseLaunchArgs } from "./launch-args.js";
import { runShell } from "./shell.js";

function toStructuredError(error: unknown): ReturnType<typeof fallbackErrorShape> {
  return fallbackErrorShape(error, "Validation", "LaunchFailure");
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const args = parseLaunchArgs(argv, { cwd: () => process.cwd() });
    const handle = await runShell(args);
    return handle.exitCode;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ surface: "cli.validation-error", error: toStructuredError(error) })}\n`,
    );
    return 1;
  }
}

export { main };
// eslint-disable-next-line import-x/no-default-export
export default main;
