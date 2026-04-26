export type HookStage =
  | "RECEIVE_INPUT"
  | "COMPOSE_REQUEST"
  | "SEND_REQUEST"
  | "STREAM_RESPONSE"
  | "TOOL_CALL"
  | "RENDER";

export type HookPosition = "pre" | "post";

export type HookSlot = `${HookStage}/${HookPosition}`;

export type HookSubKind = "transform" | "guard" | "observer";

export interface HookSlotRule {
  readonly slot: HookSlot;
  readonly allowed: readonly HookSubKind[];
  readonly rare: readonly HookSubKind[];
  readonly firesPerCall: boolean;
  readonly firesPerToken: boolean;
  readonly visibility: "args-only" | "result" | "full";
}

export const HOOK_SLOT_MATRIX: readonly HookSlotRule[] = Object.freeze([
  {
    slot: "RECEIVE_INPUT/pre",
    allowed: ["transform", "guard", "observer"],
    rare: [],
    firesPerCall: false,
    firesPerToken: false,
    visibility: "full",
  },
  {
    slot: "RECEIVE_INPUT/post",
    allowed: ["transform", "observer"],
    rare: [],
    firesPerCall: false,
    firesPerToken: false,
    visibility: "full",
  },
  {
    slot: "COMPOSE_REQUEST/pre",
    allowed: ["transform", "guard", "observer"],
    rare: [],
    firesPerCall: false,
    firesPerToken: false,
    visibility: "full",
  },
  {
    slot: "COMPOSE_REQUEST/post",
    allowed: ["transform", "observer"],
    rare: [],
    firesPerCall: false,
    firesPerToken: false,
    visibility: "full",
  },
  {
    slot: "SEND_REQUEST/pre",
    allowed: ["transform", "guard", "observer"],
    rare: ["transform"],
    firesPerCall: false,
    firesPerToken: false,
    visibility: "full",
  },
  {
    slot: "SEND_REQUEST/post",
    allowed: ["observer"],
    rare: [],
    firesPerCall: false,
    firesPerToken: false,
    visibility: "result",
  },
  {
    slot: "STREAM_RESPONSE/pre",
    allowed: ["transform", "guard", "observer"],
    rare: ["transform"],
    firesPerCall: false,
    firesPerToken: true,
    visibility: "full",
  },
  {
    slot: "STREAM_RESPONSE/post",
    allowed: ["observer"],
    rare: [],
    firesPerCall: false,
    firesPerToken: true,
    visibility: "result",
  },
  {
    slot: "TOOL_CALL/pre",
    allowed: ["transform", "guard", "observer"],
    rare: [],
    firesPerCall: true,
    firesPerToken: false,
    visibility: "args-only",
  },
  {
    slot: "TOOL_CALL/post",
    allowed: ["transform", "observer"],
    rare: [],
    firesPerCall: true,
    firesPerToken: false,
    visibility: "result",
  },
  {
    slot: "RENDER/pre",
    allowed: ["transform", "observer"],
    rare: [],
    firesPerCall: false,
    firesPerToken: false,
    visibility: "full",
  },
  {
    slot: "RENDER/post",
    allowed: ["observer"],
    rare: [],
    firesPerCall: false,
    firesPerToken: false,
    visibility: "result",
  },
] as const satisfies readonly HookSlotRule[]);
