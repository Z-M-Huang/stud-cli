/**
 * Session-resume harness — drives two sequential turns across a process
 * exit / re-launch pair using the bundled filesystem session store + the
 * session-lifecycle state machine, capturing events and the loaded
 * message history on resume.
 *
 * Pragmatic scope: the harness wires the real filesystem session store
 * and the real lifecycle state machine; the LLM provider is stubbed.
 * The unit's invariant under test is the manifest persistence + resume
 * round-trip — message history written in launch-1 is observable in
 * launch-2 — plus the SessionActive / SessionPersisted / SessionResumed
 * lifecycle event sequence.
 *
 * Wiki: flows/Session-Resume.md + core/Session-Lifecycle.md
 */

import { createEventBus } from "../../../src/core/events/bus.js";
import { createSessionStateMachine } from "../../../src/core/session-lifecycle/transitions.js";
import { contract as filesystemStoreContract } from "../../../src/extensions/session-stores/filesystem/index.js";
import { mockHost } from "../../helpers/mock-host.js";

import type { SessionManifest } from "../../../src/contracts/session-store.js";

export interface ResumeHarnessInput {
  /** Absolute path to the project root (the `.stud` directory). */
  readonly projectRoot: string;
  readonly sessionId: string;
  /** First-turn user message (persisted in launch-1). */
  readonly prompt1: string;
  /** Mock assistant response to the first turn (persisted in launch-1). */
  readonly assistant1: string;
  /** Second-turn user message (sent in launch-2). */
  readonly prompt2: string;
}

export interface ResumeHarnessOutcome {
  /** Manifest persisted by launch-1 (after Idle → Active → Persisted). */
  readonly persistedManifest: SessionManifest;
  /** Manifest loaded by launch-2 (via filesystemStore.read). */
  readonly resumedManifest: SessionManifest;
  /** Composed history visible to launch-2's "second turn" — combination of resumed + new. */
  readonly resumedRequestHistory: readonly { readonly role: string; readonly content: unknown }[];
  /** Lifecycle events emitted across both launches in chronological order. */
  readonly lifecycleEvents: readonly string[];
}

interface MutableHostHandle {
  readonly host: ReturnType<typeof mockHost>["host"];
}

function withProjectRoot(handle: MutableHostHandle, projectRoot: string): MutableHostHandle {
  // Replace the session.projectRoot in the frozen host wrapper. Tests
  // create a fresh mockHost per launch so we can swap the read-only
  // session field by recreating the frozen surface.
  const frozenSession = { ...handle.host.session, projectRoot };
  const frozenHost = Object.freeze({ ...handle.host, session: frozenSession });
  return { host: frozenHost as unknown as ReturnType<typeof mockHost>["host"] };
}

export async function runFirstTurnThenContinue(
  input: ResumeHarnessInput,
): Promise<ResumeHarnessOutcome> {
  const lifecycleEvents: string[] = [];

  // ── Launch 1: Idle → Active → Persisted ─────────────────────────────
  const bus1 = createEventBus({ monotonic: () => 1n });
  bus1.onAny((ev) => {
    if (ev.name.startsWith("Session")) lifecycleEvents.push(ev.name);
  });

  const sm1 = createSessionStateMachine({
    bus: bus1,
    deliverSmSlots: () => Promise.resolve(),
  });
  await sm1.trigger({ kind: "FirstTurn" });

  // Real filesystem store — init + activate against a mock host with the
  // configured projectRoot.
  const launch1Handle = withProjectRoot(mockHost({ extId: "filesystem" }), input.projectRoot);
  await filesystemStoreContract.lifecycle.init?.(launch1Handle.host, {
    rootDir: input.projectRoot,
  });
  await filesystemStoreContract.lifecycle.activate?.(launch1Handle.host);

  const persistedManifest: SessionManifest = {
    sessionId: input.sessionId,
    projectRoot: input.projectRoot,
    mode: "ask",
    storeId: filesystemStoreContract.storeId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      { id: "m1", role: "user", content: input.prompt1, monotonicTs: "1" },
      { id: "m2", role: "assistant", content: input.assistant1, monotonicTs: "2" },
    ],
  };
  const writeResult = await filesystemStoreContract.write(
    persistedManifest,
    [],
    launch1Handle.host,
  );
  if (!writeResult.ok) {
    throw new Error(`launch-1 write failed: ${writeResult.error.message}`);
  }
  await sm1.trigger({ kind: "Snapshot" });
  await sm1.trigger({ kind: "Sigterm" });

  await filesystemStoreContract.lifecycle.deactivate?.(launch1Handle.host);
  await filesystemStoreContract.lifecycle.dispose?.(launch1Handle.host);

  // ── Launch 2: Idle → Resumed → Active (resume + second turn) ────────
  const bus2 = createEventBus({ monotonic: () => 2n });
  bus2.onAny((ev) => {
    if (ev.name.startsWith("Session")) lifecycleEvents.push(ev.name);
  });

  const sm2 = createSessionStateMachine({
    bus: bus2,
    deliverSmSlots: () => Promise.resolve(),
  });

  const launch2Handle = withProjectRoot(mockHost({ extId: "filesystem" }), input.projectRoot);
  await filesystemStoreContract.lifecycle.init?.(launch2Handle.host, {
    rootDir: input.projectRoot,
  });
  await filesystemStoreContract.lifecycle.activate?.(launch2Handle.host);

  const readResult = await filesystemStoreContract.read(input.sessionId, launch2Handle.host);
  if (!readResult.ok) {
    throw new Error(`launch-2 read failed: ${readResult.error.message}`);
  }
  const resumedManifest = readResult.manifest;

  // Launch-2 starts in Idle. Walk the legal path to Resumed→Active:
  // Idle→Active(FirstTurn)→Persisted(Snapshot)→Closed(Sigterm)→Resumed(Resume)→Active(FirstTurn).
  await sm2.trigger({ kind: "FirstTurn" });
  await sm2.trigger({ kind: "Snapshot" });
  await sm2.trigger({ kind: "Sigterm" });
  await sm2.trigger({ kind: "Resume" });
  await sm2.trigger({ kind: "FirstTurn" });

  // Compose the launch-2 turn's history: resumed messages + new user prompt.
  const resumedRequestHistory: { readonly role: string; readonly content: unknown }[] = [
    ...resumedManifest.messages.map((m) => {
      const rawRole = (m as { role?: unknown }).role;
      const role = typeof rawRole === "string" ? rawRole : "user";
      return { role, content: (m as { content?: unknown }).content };
    }),
    { role: "user", content: input.prompt2 },
  ];

  await filesystemStoreContract.lifecycle.deactivate?.(launch2Handle.host);
  await filesystemStoreContract.lifecycle.dispose?.(launch2Handle.host);

  return {
    persistedManifest,
    resumedManifest,
    resumedRequestHistory,
    lifecycleEvents,
  };
}
