/**
 * AskUserArgs — input arguments for the ask-user reference tool.
 *
 * `prompt`       — required; the question to present to the user.
 * `placeholder`  — optional UI hint for the input field.
 * `defaultValue` — optional pre-filled text (advisory; the interactor may ignore it).
 *
 * Wiki: reference-extensions/tools/Ask-User.md
 */

export interface AskUserArgs {
  readonly prompt: string;
  readonly placeholder?: string;
  readonly defaultValue?: string;
}
