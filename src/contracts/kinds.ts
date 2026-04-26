/**
 * Closed union of every extension category recognised by stud-cli core.
 *
 * Nine categories; each extension belongs to exactly one.
 * Multi-role hybrids are non-conformant — see CLAUDE.md §2 invariant 4.
 *
 * Wiki: contracts/Contract-Pattern.md + overview/Extensibility-Boundary.md
 */
export type CategoryKind =
  | "Provider"
  | "Tool"
  | "Hook"
  | "UI"
  | "Logger"
  | "StateMachine"
  | "Command"
  | "SessionStore"
  | "ContextProvider";
