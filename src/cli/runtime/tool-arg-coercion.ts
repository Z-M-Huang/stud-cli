function getString(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

export function coerceBashArgs(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return args;
  }
  const record = args as Readonly<Record<string, unknown>>;
  if (typeof record["command"] === "string") {
    return args;
  }
  const command = getString(record, ["cmd", "shell_command", "command_line"]);
  return command === null ? args : { ...record, command };
}
