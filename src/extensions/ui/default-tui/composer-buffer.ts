/**
 * Composer buffer — paste-aware text accumulator for the bundled TUI's input
 * box. Large paste chunks are stored verbatim but rendered as
 * `[pasted content #N]` placeholders; the LLM, audit surface, token counter,
 * and context assembly all see the resolved input on submit.
 *
 * Paste detection sources (in order of preference):
 *   1. Bracketed-paste mode (`ESC[200~ ... ESC[201~`).
 *   2. A "≥N chars in a single keypress chunk" heuristic, configurable via
 *      `pasteCollapseChars`.
 *
 * Wiki: reference-extensions/ui/Default-TUI.md § Composer sizing and pasted content
 */

export interface PastedRegion {
  readonly kind: "paste";
  readonly id: number;
  readonly text: string;
}

export interface TypedRegion {
  readonly kind: "typed";
  readonly text: string;
}

export type ComposerRegion = TypedRegion | PastedRegion;

export interface ComposerBuffer {
  /** The visible draft (with placeholders for pasted regions). */
  readonly display: string;
  /** The fully resolved text used on submit. */
  readonly resolved: string;
  readonly regions: readonly ComposerRegion[];
}

export interface ComposerBufferOptions {
  /** Threshold for the keypress-chunk heuristic. Default 200. */
  readonly pasteCollapseChars?: number;
}

const DEFAULT_PASTE_THRESHOLD = 200;

function placeholder(id: number): string {
  return `[pasted content #${id.toString()}]`;
}

function emptyRegions(): ComposerRegion[] {
  return [];
}

function rebuild(regions: readonly ComposerRegion[]): ComposerBuffer {
  let display = "";
  let resolved = "";
  for (const region of regions) {
    if (region.kind === "typed") {
      display += region.text;
      resolved += region.text;
    } else {
      display += placeholder(region.id);
      resolved += region.text;
    }
  }
  return { display, resolved, regions };
}

/** Build an empty composer buffer. */
export function createComposerBuffer(): ComposerBuffer {
  return rebuild(emptyRegions());
}

/**
 * Append a chunk of input. The chunk is treated as a paste when it exceeds
 * `pasteCollapseChars`, *or* when `forcePaste` is true (used when bracketed
 * paste mode is detected).
 */
export function append(
  buffer: ComposerBuffer,
  chunk: string,
  options: { readonly forcePaste?: boolean } & ComposerBufferOptions = {},
): ComposerBuffer {
  const threshold = options.pasteCollapseChars ?? DEFAULT_PASTE_THRESHOLD;
  const treatAsPaste = options.forcePaste === true || chunk.length >= threshold;
  const regions = [...buffer.regions];
  if (treatAsPaste) {
    const id = regions.filter((r) => r.kind === "paste").length + 1;
    regions.push({ kind: "paste", id, text: chunk });
  } else {
    const last = regions[regions.length - 1];
    if (last?.kind === "typed") {
      regions[regions.length - 1] = { kind: "typed", text: last.text + chunk };
    } else {
      regions.push({ kind: "typed", text: chunk });
    }
  }
  return rebuild(regions);
}

/** Pop the trailing character (or pasted region) atomically. */
export function backspace(buffer: ComposerBuffer): ComposerBuffer {
  if (buffer.regions.length === 0) {
    return buffer;
  }
  const regions = [...buffer.regions];
  const last = regions[regions.length - 1]!;
  if (last.kind === "paste") {
    regions.pop();
  } else if (last.text.length <= 1) {
    regions.pop();
  } else {
    regions[regions.length - 1] = { kind: "typed", text: last.text.slice(0, -1) };
  }
  return rebuild(regions);
}

/** Reset to empty. */
export function clear(): ComposerBuffer {
  return createComposerBuffer();
}
