import type { AssembledRequest } from "./assembler.js";

interface AuditWriter {
  write(record: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface IsolationInput {
  readonly assembled: AssembledRequest;
  readonly secrets: ResolvedSecretCorpus;
  readonly audit: AuditWriter;
  readonly userInput: readonly string[];
}

export interface ResolvedSecretCorpus {
  readonly resolvedEnvValues: readonly {
    readonly extId: string;
    readonly name: string;
    readonly value: string;
  }[];
  readonly settingsLeafValues: readonly {
    readonly path: string;
    readonly value: string;
  }[];
}

export interface IsolationVerdict {
  readonly clean: boolean;
  readonly violations: readonly IsolationViolation[];
}

export interface IsolationViolation {
  readonly source: "env" | "settings";
  readonly identifier: string;
  readonly fragmentOwnerExtId?: string;
  readonly matchedOn: "systemPrompt" | "history" | "tools" | "fragment";
}

interface SurfaceMatch {
  readonly matchedOn: IsolationViolation["matchedOn"];
  readonly content: string;
  readonly fragmentOwnerExtId?: string;
}

function shouldSkipSecret(value: string, userInput: readonly string[]): boolean {
  if (value.length === 0) {
    return true;
  }

  return userInput.some((entry) => entry.includes(value));
}

function collectSurfaces(assembled: AssembledRequest): readonly SurfaceMatch[] {
  const history = assembled.history.map((message) => ({
    matchedOn: "history" as const,
    content: message.content,
  }));
  const tools = assembled.toolManifest.map((tool) => ({
    matchedOn: "tools" as const,
    content: JSON.stringify(tool),
  }));
  const fragments = assembled.fragments.map((fragment) => ({
    matchedOn: "fragment" as const,
    content: fragment.content,
    fragmentOwnerExtId: fragment.ownerExtId,
  }));

  return [
    { matchedOn: "systemPrompt", content: assembled.systemPrompt },
    ...history,
    ...tools,
    ...fragments,
  ];
}

function appendViolations(args: {
  readonly source: IsolationViolation["source"];
  readonly identifier: string;
  readonly value: string;
  readonly surfaces: readonly SurfaceMatch[];
  readonly userInput: readonly string[];
  readonly violations: IsolationViolation[];
}): void {
  if (shouldSkipSecret(args.value, args.userInput)) {
    return;
  }

  for (const surface of args.surfaces) {
    if (!surface.content.includes(args.value)) {
      continue;
    }

    args.violations.push({
      source: args.source,
      identifier: args.identifier,
      ...(surface.fragmentOwnerExtId === undefined
        ? {}
        : { fragmentOwnerExtId: surface.fragmentOwnerExtId }),
      matchedOn: surface.matchedOn,
    });
  }
}

export function scanForLeaks(input: IsolationInput): IsolationVerdict {
  void input.audit;

  const violations: IsolationViolation[] = [];
  const surfaces = collectSurfaces(input.assembled);

  for (const secret of input.secrets.resolvedEnvValues) {
    appendViolations({
      source: "env",
      identifier: secret.name,
      value: secret.value,
      surfaces,
      userInput: input.userInput,
      violations,
    });
  }

  for (const secret of input.secrets.settingsLeafValues) {
    appendViolations({
      source: "settings",
      identifier: secret.path,
      value: secret.value,
      surfaces,
      userInput: input.userInput,
      violations,
    });
  }

  return {
    clean: violations.length === 0,
    violations,
  };
}
