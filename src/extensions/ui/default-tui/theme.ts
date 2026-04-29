/**
 * Color palette for the bundled "Concept C" Ink layout.
 *
 * The wiki reference at `../../../stud-cli.wiki/assets/ui/default-tui-concept-c.png`
 * shows a deep navy / near-black background, warm off-white transcript text, and
 * green / coral / cyan accents. Ink renders against the host terminal's actual
 * background, so we apply background colors only to contrasting surfaces (header,
 * tool cards, palette overlays). The default text color is the warm off-white.
 *
 * `NO_COLOR` and `TERM=dumb` are honored by `useColor()` below — when either is
 * set, every accessor returns `undefined`, and Ink renders without color codes.
 *
 * Wiki: reference-extensions/ui/Default-TUI.md § Visual direction
 */

export interface Theme {
  /** Default body text. Warm off-white. */
  readonly text: string;
  /** Dim text for hints, secondary metadata, status-line labels. */
  readonly muted: string;
  /** Primary accent — assistant labels, success badges, "online" dot. */
  readonly accent: string;
  /** Secondary accent — user labels, info, links. */
  readonly info: string;
  /** Warning accent — non-fatal notices, mode warnings. */
  readonly warn: string;
  /** Failure accent — errors, denied approvals, offline indicator. */
  readonly bad: string;
  /** Background fill for header strip / contrasting surfaces. */
  readonly surface: string;
  /** Subtle border color. */
  readonly border: string;
}

const DARK_THEME: Theme = {
  text: "#E8DCC4",
  muted: "#6C7280",
  accent: "#7FBA72",
  info: "#4FC3DC",
  warn: "#E0B040",
  bad: "#E85A4F",
  surface: "#0A0E1A",
  border: "#2A3142",
};

export function shouldUseColor(stdout: NodeJS.WriteStream | undefined): boolean {
  if (process.env["NO_COLOR"] !== undefined) {
    return false;
  }
  if (process.env["TERM"] === "dumb") {
    return false;
  }
  return Boolean(stdout?.isTTY ?? false);
}

/**
 * Returns the active theme, or `undefined` when color is suppressed.
 * Render code should pass `theme?.<token>` directly to Ink; `undefined` causes
 * Ink to fall back to the terminal's default foreground.
 */
export function defaultTheme(stdout: NodeJS.WriteStream | undefined): Theme | undefined {
  return shouldUseColor(stdout) ? DARK_THEME : undefined;
}
