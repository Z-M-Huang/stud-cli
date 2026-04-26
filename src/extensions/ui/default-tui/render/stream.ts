export interface StreamDelta {
  readonly correlationId: string;
  readonly text: string;
}

export interface StreamRenderState {
  readonly lines: readonly string[];
  readonly rendered: string;
}

export function appendStreamDelta(
  state: StreamRenderState,
  delta: StreamDelta,
  maxLogLines: number,
): StreamRenderState {
  const previous = state.lines.at(-1) ?? "";
  const nextLine = `${previous}${delta.text}`;
  const nextLines = [...state.lines.slice(0, -1), nextLine].slice(-maxLogLines);
  return {
    lines: nextLines,
    rendered: nextLines.join("\n"),
  };
}

export function beginTurn(state: StreamRenderState, maxLogLines: number): StreamRenderState {
  const nextLines = [...state.lines, ""].slice(-maxLogLines);
  return {
    lines: nextLines,
    rendered: nextLines.join("\n"),
  };
}

export function createInitialStreamState(): StreamRenderState {
  return {
    lines: [""],
    rendered: "",
  };
}
