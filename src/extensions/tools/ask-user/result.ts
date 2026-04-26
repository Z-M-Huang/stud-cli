/**
 * AskUserResult — output shape returned by the ask-user reference tool.
 *
 * `answer`    — the text entered by the user.
 * `cancelled` — always `false`; the tool throws `Cancellation/TurnCancelled`
 *               when the user dismisses the dialog, so a resolved result is
 *               never cancelled.
 *
 * Wiki: reference-extensions/tools/Ask-User.md
 */

export interface AskUserResult {
  readonly answer: string;
  readonly cancelled: false;
}
