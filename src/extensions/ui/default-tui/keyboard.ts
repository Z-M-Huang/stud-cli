export interface KeyboardShortcut {
  readonly binding: "Ctrl-C" | "Ctrl-J" | "Ctrl-M";
  readonly action: "cancel-turn" | "stage-step" | "show-mode";
  readonly description: string;
}

export function keyboardShortcuts(): readonly KeyboardShortcut[] {
  return [
    {
      binding: "Ctrl-C",
      action: "cancel-turn",
      description: "Cancel the current turn",
    },
    {
      binding: "Ctrl-J",
      action: "stage-step",
      description: "Advance one state-machine stage step",
    },
    {
      binding: "Ctrl-M",
      action: "show-mode",
      description: "Display the current read-only mode",
    },
  ];
}
