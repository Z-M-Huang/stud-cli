/**
 * Subagents panel — a region contribution that surfaces running subagent
 * cards beneath the transcript. Wiki:
 * reference-extensions/ui/Default-TUI.md §Subagents panel +
 * core/Subagent-Sessions.md §Default-TUI subagent panel.
 *
 * The panel subscribes to `Subagent*` audit events (Spawned / Completed /
 * Halted / Aborted / EscalEscalated) and renders one card per running child.
 * Reconciles every 2s against `host.audit.activeSubagents()` so the
 * authoritative view matches the audit-derived projection.
 */

import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";

import type { EventBus } from "../../../../core/events/bus.js";
import type { UIRegionContribution, UIRegionRegistry } from "../regions.js";

interface SubagentCard {
  readonly subagentId: string;
  readonly depth: number;
  readonly label?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly envelope: readonly string[];
  readonly state: "spawned" | "running" | "completed" | "halted" | "aborted";
  readonly escalations: number;
  readonly lastActivityAt: number;
  /**
   * Set on terminal events that carry one — `SubagentAborted.reason`,
   * `SubagentHalted.requestKind`. Surfaced inline so the user sees
   * *why* a subagent stopped rather than the bare state ("aborted").
   */
  readonly reason?: string;
}

const FADE_AFTER_MS = 5_000;

interface SubagentsPanelProps {
  readonly cards: readonly SubagentCard[];
}

function SubagentsPanelInner(input: {
  readonly bus: EventBus;
  readonly activeSubagents: () => readonly ActiveSubagentInput[];
}): React.ReactElement {
  const cards = useSubagentCards(input);
  // Always emit the same outer Box shape so the live frame's height does
  // not jump when the cards list transitions empty ⇄ non-empty (Ink's
  // log-update has known orphan-row symptoms when the live frame's child
  // tree changes height; see ink-app.tsx top-row spacer comment).
  return (
    <Box flexDirection="column">
      {cards.length === 0 ? null : <Text dimColor>subagents</Text>}
      {cards.map((card) => (
        <Text key={card.subagentId} color={colorForState(card.state)}>
          {renderCardLine(card)}
        </Text>
      ))}
    </Box>
  );
}

/**
 * One-line text for a subagent card. Plain English over jargon: "failed
 * (provider error)" beats `[depth 1] aborted · providerFailure` for a
 * user who is not reading the wiki.
 */
function renderCardLine(card: SubagentCard): string {
  const id = card.subagentId.slice(0, 8);
  const label = card.label !== undefined ? ` "${card.label}"` : "";
  // Omit depth chip at depth=1 (the common case — direct child of
  // orchestrator); only nested delegations need the chip to disambiguate.
  const depth = card.depth > 1 ? ` [depth ${card.depth}]` : "";
  const escalations = card.escalations > 0 ? ` · ${card.escalations} escalations` : "";
  const envelope = card.envelope.length > 0 ? ` · {${card.envelope.join(", ")}}` : "";
  return `  · ${id}${label}${depth} ${stateLabel(card)}${escalations}${envelope}`;
}

/**
 * Translate the internal lifecycle state into a phrase the user can
 * interpret. `aborted` → `failed (<reason>)` so the panel matches what
 * the orchestrator's own text says ("subagent failed due to ...").
 */
function stateLabel(card: SubagentCard): string {
  switch (card.state) {
    case "running":
      return "running";
    case "spawned":
      return "starting";
    case "completed":
      return "completed";
    case "halted":
      return card.reason !== undefined ? `paused (waiting on ${card.reason})` : "paused";
    case "aborted":
      return card.reason !== undefined ? `failed (${humanizeAbortReason(card.reason)})` : "failed";
  }
}

function humanizeAbortReason(reason: string): string {
  switch (reason) {
    case "providerFailure":
      return "provider error";
    case "parentCancel":
      return "cancelled";
    case "depthExceeded":
      return "nesting limit reached";
    case "envelopeInvalid":
      return "invalid tool envelope";
    case "modelInvalid":
      return "model not configured";
    case "modelCapabilityMismatch":
      return "model lacks required capability";
    case "crash":
      return "previous run crashed";
    default:
      return reason;
  }
}

interface ActiveSubagentInput {
  readonly subagentId: string;
  readonly parentSessionId: string;
  readonly depth: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly approvedEnvelope: readonly string[];
  readonly spawnedAt: number;
}

/**
 * Shallow per-field equality of two card arrays. Returns `true` when both
 * are the same length and every card at the same index is field-for-field
 * equal. Avoids re-renders when the periodic 2s poll projects an
 * unchanged set (the common case when no subagents have spawned).
 */
function cardsEqual(a: readonly SubagentCard[], b: readonly SubagentCard[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (
      x.subagentId !== y.subagentId ||
      x.depth !== y.depth ||
      x.label !== y.label ||
      x.providerId !== y.providerId ||
      x.modelId !== y.modelId ||
      x.state !== y.state ||
      x.escalations !== y.escalations ||
      x.lastActivityAt !== y.lastActivityAt ||
      x.reason !== y.reason
    ) {
      return false;
    }
    if (x.envelope.length !== y.envelope.length) return false;
    for (let j = 0; j < x.envelope.length; j += 1) {
      if (x.envelope[j] !== y.envelope[j]) return false;
    }
  }
  return true;
}

function colorForState(state: SubagentCard["state"]): string {
  switch (state) {
    case "running":
      return "cyan";
    case "spawned":
      return "yellow";
    case "completed":
      return "green";
    case "halted":
      return "magenta";
    case "aborted":
      return "red";
  }
}

/**
 * Hook the panel into the event bus + audit query. The hook returns a
 * stable `cards` array that reflects the audit-derived running set with
 * a 5-second fade window for terminal cards.
 */
export function useSubagentCards(input: {
  readonly bus: EventBus;
  readonly activeSubagents: () => readonly ActiveSubagentInput[];
}): readonly SubagentCard[] {
  const [cards, setCards] = useState<readonly SubagentCard[]>([]);

  useEffect(() => {
    const ctrl = createCardsController(input.activeSubagents, setCards);
    const off1 = input.bus.on("SubagentSpawned", (env) => ctrl.onSpawned(env));
    const off2 = input.bus.on("SubagentCompleted", (env) => ctrl.onTerminal("completed", env));
    const off3 = input.bus.on("SubagentHalted", (env) => ctrl.onTerminal("halted", env));
    const off4 = input.bus.on("SubagentAborted", (env) => ctrl.onTerminal("aborted", env));
    const off5 = input.bus.on("SubagentEscalated", (env) => ctrl.onEscalated(env));
    const interval = setInterval(() => ctrl.reconcile(), 2_000);
    return (): void => {
      clearInterval(interval);
      off1();
      off2();
      off3();
      off4();
      off5();
    };
  }, [input.bus, input.activeSubagents]);

  return cards;
}

interface CardsController {
  reconcile(): void;
  onSpawned(env: { payload: unknown }): void;
  onTerminal(state: "completed" | "halted" | "aborted", env: { payload: unknown }): void;
  onEscalated(env: { payload: unknown }): void;
}

/**
 * Per-mount state holder for the subagents panel. Holds the live `Map` of
 * cards and exposes the four event handlers + the periodic reconcile pass.
 * Extracted from `useSubagentCards` so the hook body stays small enough
 * for the per-function line cap.
 */
function createCardsController(
  activeSubagents: () => readonly ActiveSubagentInput[],
  setCards: (updater: (prev: readonly SubagentCard[]) => readonly SubagentCard[]) => void,
): CardsController {
  const map = new Map<string, SubagentCard>();
  const reconcile = (): void => {
    projectActiveIntoMap(activeSubagents(), map);
    const nextArr = Array.from(map.values());
    // Only commit when the projected card set actually changed. The 2s
    // poll is otherwise unconditional and would force a re-render of the
    // entire Ink live frame, triggering log-update orphan-row symptoms
    // beneath every newly-committed transcript item.
    setCards((prev) => (cardsEqual(prev, nextArr) ? prev : nextArr));
  };
  return {
    reconcile,
    onSpawned: (env) => {
      applySpawned(map, env.payload);
      reconcile();
    },
    onTerminal: (state, env) => {
      applyTerminal(map, state, env.payload);
      reconcile();
    },
    onEscalated: (env) => {
      applyEscalated(map, env.payload);
      reconcile();
    },
  };
}

function projectActiveIntoMap(
  active: readonly ActiveSubagentInput[],
  map: Map<string, SubagentCard>,
): void {
  const now = Date.now();
  const next = new Map<string, SubagentCard>();
  for (const entry of active) {
    const existing = map.get(entry.subagentId);
    next.set(entry.subagentId, {
      subagentId: entry.subagentId,
      depth: entry.depth,
      providerId: entry.providerId,
      modelId: entry.modelId,
      envelope: entry.approvedEnvelope,
      state: existing?.state ?? "spawned",
      escalations: existing?.escalations ?? 0,
      lastActivityAt: existing?.lastActivityAt ?? now,
      ...(existing?.reason !== undefined ? { reason: existing.reason } : {}),
    });
  }
  // Keep recently-terminated cards visible for the fade window.
  for (const [id, card] of map) {
    if (next.has(id)) continue;
    if (now - card.lastActivityAt < FADE_AFTER_MS) next.set(id, card);
  }
  map.clear();
  for (const [id, card] of next) map.set(id, card);
}

function applySpawned(map: Map<string, SubagentCard>, payload: unknown): void {
  const p = payload as {
    subagentId?: string;
    depth?: number;
    approvedEnvelope?: readonly string[];
    providerId?: string;
    modelId?: string;
    label?: string;
  };
  if (typeof p.subagentId !== "string") return;
  map.set(p.subagentId, {
    subagentId: p.subagentId,
    depth: typeof p.depth === "number" ? p.depth : 1,
    ...(typeof p.label === "string" ? { label: p.label } : {}),
    ...(typeof p.providerId === "string" ? { providerId: p.providerId } : {}),
    ...(typeof p.modelId === "string" ? { modelId: p.modelId } : {}),
    envelope: Array.isArray(p.approvedEnvelope) ? p.approvedEnvelope : [],
    state: "running",
    escalations: 0,
    lastActivityAt: Date.now(),
  });
}

function applyTerminal(
  map: Map<string, SubagentCard>,
  state: "completed" | "halted" | "aborted",
  payload: unknown,
): void {
  const p = payload as {
    subagentId?: string;
    reason?: string;
    requestKind?: string;
  };
  if (typeof p.subagentId !== "string") return;
  const card = map.get(p.subagentId);
  if (card === undefined) return;
  // SubagentAborted carries `reason`; SubagentHalted carries `requestKind`
  // (the IP kind that paused the child). Either surfaces inline on the
  // card so the user can see *why* a subagent stopped rather than the
  // bare state name.
  const reason =
    state === "aborted" && typeof p.reason === "string"
      ? p.reason
      : state === "halted" && typeof p.requestKind === "string"
        ? p.requestKind
        : undefined;
  map.set(p.subagentId, {
    ...card,
    state,
    lastActivityAt: Date.now(),
    ...(reason !== undefined ? { reason } : {}),
  });
}

function applyEscalated(map: Map<string, SubagentCard>, payload: unknown): void {
  const p = payload as { subagentId?: string };
  if (typeof p.subagentId !== "string") return;
  const card = map.get(p.subagentId);
  if (card === undefined) return;
  map.set(p.subagentId, {
    ...card,
    escalations: card.escalations + 1,
    lastActivityAt: Date.now(),
  });
}

/**
 * Register the Subagents panel as the first bundled region contribution
 * under `transcript`. Wires the EventBus + audit accessor at registration
 * time so the panel component can subscribe + reconcile internally.
 */
export function registerSubagentsPanel(
  registry: UIRegionRegistry,
  deps: {
    readonly bus: EventBus;
    readonly activeSubagents: () => readonly ActiveSubagentInput[];
  },
): void {
  const contribution: UIRegionContribution = {
    id: "bundled-subagents-panel",
    region: "transcript",
    mode: "append",
    priority: 100,
    component: () => React.createElement(SubagentsPanelInner, deps),
  };
  registry.register(contribution);
}

export type { SubagentCard, SubagentsPanelProps, ActiveSubagentInput };
