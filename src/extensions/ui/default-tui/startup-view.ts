export interface StartupFailure {
  readonly extId: string;
  readonly reason: string;
}

export interface StartupSurface {
  readonly warnings: number;
  readonly errors: number;
  readonly failures: readonly StartupFailure[];
}

export interface StartupViewModel {
  readonly header: string;
  readonly details: readonly string[];
}

export function renderStartupView(surface: StartupSurface): StartupViewModel {
  return {
    header: `${surface.warnings} warnings, ${surface.errors} errors`,
    details: surface.failures.map((failure) => `${failure.extId}: ${failure.reason}`),
  };
}
