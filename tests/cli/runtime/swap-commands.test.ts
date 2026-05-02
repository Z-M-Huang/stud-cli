/**
 * Tests for the `/model` and `/provider` swap commands.
 *
 * Critical regression coverage: two same-protocol provider entries with
 * different `baseURL` / `apiKeyRef` must use distinct runtime contexts so
 * that a swap from one to the other does not silently keep the previous
 * entry's `baseURL`/`apiKeyRef` (per the gpt-5.5 review and the
 * runtime-context-registry's per-entryId keying).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createActiveSelectionHolder } from "../../../src/cli/runtime/active-selection.js";
import { createParamsRuntimeStore } from "../../../src/cli/runtime/params-runtime.js";
import { createRuntimeContextRegistry } from "../../../src/cli/runtime/runtime-context-registry.js";
import {
  dispatchModelCommand,
  dispatchProviderCommand,
} from "../../../src/cli/runtime/swap-commands.js";
import { Cancellation } from "../../../src/core/errors/index.js";
import { createEventBus } from "../../../src/core/events/bus.js";
import { createRuntimeCollector } from "../../../src/core/host/internal/runtime-collector.js";

import type { SessionAuditBus } from "../../../src/cli/runtime/audit-bus.js";
import type {
  ProviderSelection,
  ResolvedShellDeps,
  SessionBootstrap,
  Settings,
} from "../../../src/cli/runtime/types.js";
import type { InteractionAPI } from "../../../src/core/host/api/interaction.js";

interface Captured {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function fakeAuditBus(captured: Captured[]): SessionAuditBus {
  return {
    emit: (type: string, payload: Readonly<Record<string, unknown>>) => {
      captured.push({ type, payload });
    },
    withTurn: async <T>(_id: string, run: () => Promise<T>): Promise<T> => run(),
    close: () => Promise.resolve(),
  } as unknown as SessionAuditBus;
}

function fakeDeps(home: string): ResolvedShellDeps {
  return {
    env: {},
    homedir: () => home,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    packageVersion: "0.0.0-test",
    now: () => new Date("2026-04-30T00:00:00.000Z"),
    sessionIdFactory: () => "session-test",
    runSession: () => Promise.resolve(),
  };
}

function bailianSelection(): ProviderSelection {
  return {
    entryId: "bailian",
    protocolId: "openai-compatible",
    modelId: "qwen3.6-plus",
    config: {
      protocol: "openai-compatible",
      apiKeyRef: { kind: "env", name: "BAILIAN_API_KEY" },
      baseURL: "http://192.168.1.253:8317/v1",
      models: ["qwen3.6-plus"],
    },
  };
}

async function withSettings(
  contents: Settings,
  run: (paths: {
    readonly home: string;
    readonly projectRoot: string;
    readonly globalPath: string;
  }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "stud-swap-home-"));
  const project = await mkdtemp(join(tmpdir(), "stud-swap-project-"));
  const projectRoot = join(project, ".stud");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(home, ".stud"), { recursive: true });
  const globalPath = join(home, ".stud", "settings.json");
  await writeFile(globalPath, JSON.stringify(contents));
  try {
    await run({ home, projectRoot, globalPath });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
}

function autoFirstInteraction(): InteractionAPI {
  return {
    raise(req) {
      if (req.kind === "select") {
        const first = req.options?.[0] ?? "";
        return Promise.resolve({ value: first });
      }
      return Promise.resolve({ value: "" });
    },
  };
}

describe("/provider swap — entryId-keyed runtime context isolation", () => {
  it("publishes a new selection that carries the target entry's distinct baseURL/apiKeyRef", async () => {
    const settings: Settings = {
      providers: {
        bailian: {
          protocol: "openai-compatible",
          apiKeyRef: { kind: "env", name: "BAILIAN_API_KEY" },
          baseURL: "http://192.168.1.253:8317/v1",
          models: ["qwen3.6-plus"],
        },
        "openai-prod": {
          protocol: "openai-compatible",
          apiKeyRef: { kind: "env", name: "OPENAI_API_KEY" },
          baseURL: "https://api.openai.com/v1",
          models: ["gpt-4o"],
        },
      },
      active: { provider: "bailian", model: "qwen3.6-plus" },
    };

    await withSettings(settings, async ({ home, projectRoot, globalPath }) => {
      const deps = fakeDeps(home);
      const captured: Captured[] = [];
      const auditBus = fakeAuditBus(captured);
      const initial = bailianSelection();
      const selection = createActiveSelectionHolder(initial);

      const session: SessionBootstrap = {
        sessionId: "session-test",
        selection,
        projectRoot,
        projectTrusted: true,
        securityMode: "ask",
        manifest: { storeId: "filesystem-session-store" } as SessionBootstrap["manifest"],
        resumed: false,
        yolo: false,
        paramsStore: createParamsRuntimeStore({}),
      };

      const eventBus = createEventBus({ monotonic: () => 0n });
      const collector = createRuntimeCollector({ now: () => 0 });
      const registry = createRuntimeContextRegistry({
        session,
        deps,
        loadedTools: [],
        getAuditBus: () => auditBus,
        collector,
        eventBus,
      });
      // Seed the registry with the initial entry so the swap teardown finds it.
      await registry.ensure({
        entryId: initial.entryId,
        protocolId: initial.protocolId,
        config: initial.config,
      });

      const result = await dispatchProviderCommand(
        {
          session,
          deps,
          interaction: autoFirstInteraction(),
          auditBus,
          registry,
          projectRoot,
        },
        "openai-prod",
      );

      assert.equal(result.kind, "swapped");
      const current = selection.current();
      assert.equal(current.entryId, "openai-prod");
      const cfg = current.config as {
        readonly baseURL: string;
        readonly apiKeyRef: { readonly name: string };
      };
      // Regression: the swap must surface the target entry's baseURL/apiKeyRef,
      // not the previous entry's. (Same-protocol-different-entry safety bug.)
      assert.equal(cfg.baseURL, "https://api.openai.com/v1");
      assert.equal(cfg.apiKeyRef.name, "OPENAI_API_KEY");

      assert.equal(selection.revisionId(), 1);
      const audited = captured.map((c) => c.type);
      assert.ok(audited.includes("ModelSwitch"));

      const persisted = JSON.parse(await readFile(globalPath, "utf8")) as {
        readonly active?: { readonly provider?: string; readonly model?: string };
      };
      assert.equal(persisted.active?.provider, "openai-prod");
      assert.equal(persisted.active?.model, "gpt-4o");
    });
  });
});

describe("/provider swap — active.model fallback", () => {
  it("falls back to target.models[0] when active.model is not in the target entry's models", async () => {
    const settings: Settings = {
      providers: {
        bailian: {
          protocol: "openai-compatible",
          apiKeyRef: { kind: "env", name: "BAILIAN_API_KEY" },
          baseURL: "http://x/v1",
          models: ["qwen"],
        },
        target: {
          protocol: "openai-compatible",
          apiKeyRef: { kind: "env", name: "T_KEY" },
          baseURL: "http://y/v1",
          models: ["only-model"],
        },
      },
      active: { provider: "bailian", model: "qwen" }, // active.model not in target
    };

    await withSettings(settings, async ({ home, projectRoot }) => {
      const deps = fakeDeps(home);
      const captured: Captured[] = [];
      const auditBus = fakeAuditBus(captured);
      const initial = bailianSelection();
      const selection = createActiveSelectionHolder(initial);
      const session: SessionBootstrap = {
        sessionId: "session-test-2",
        selection,
        projectRoot,
        projectTrusted: true,
        securityMode: "ask",
        manifest: { storeId: "filesystem-session-store" } as SessionBootstrap["manifest"],
        resumed: false,
        yolo: false,
        paramsStore: createParamsRuntimeStore({}),
      };

      const eventBus = createEventBus({ monotonic: () => 0n });
      const collector = createRuntimeCollector({ now: () => 0 });
      const registry = createRuntimeContextRegistry({
        session,
        deps,
        loadedTools: [],
        getAuditBus: () => auditBus,
        collector,
        eventBus,
      });
      await registry.ensure({
        entryId: initial.entryId,
        protocolId: initial.protocolId,
        config: initial.config,
      });

      const result = await dispatchProviderCommand(
        {
          session,
          deps,
          interaction: autoFirstInteraction(),
          auditBus,
          registry,
          projectRoot,
        },
        "target",
      );

      assert.equal(result.kind, "swapped");
      assert.equal(selection.current().entryId, "target");
      assert.equal(selection.current().modelId, "only-model");
    });
  });
});

describe("/model swap — cancellation", () => {
  it("leaves holder + revisionId + settings unchanged when interaction.raise rejects", async () => {
    const settings: Settings = {
      providers: {
        bailian: {
          protocol: "openai-compatible",
          apiKeyRef: { kind: "env", name: "BAILIAN_API_KEY" },
          baseURL: "http://x/v1",
          models: ["qwen", "glm"],
        },
      },
      active: { provider: "bailian", model: "qwen" },
    };

    await withSettings(settings, async ({ home, projectRoot, globalPath }) => {
      const deps = fakeDeps(home);
      const captured: Captured[] = [];
      const auditBus = fakeAuditBus(captured);
      const initial = bailianSelection();
      const selection = createActiveSelectionHolder(initial);
      const session: SessionBootstrap = {
        sessionId: "session-cancel",
        selection,
        projectRoot,
        projectTrusted: true,
        securityMode: "ask",
        manifest: { storeId: "filesystem-session-store" } as SessionBootstrap["manifest"],
        resumed: false,
        yolo: false,
        paramsStore: createParamsRuntimeStore({}),
      };
      const eventBus = createEventBus({ monotonic: () => 0n });
      const collector = createRuntimeCollector({ now: () => 0 });
      const registry = createRuntimeContextRegistry({
        session,
        deps,
        loadedTools: [],
        getAuditBus: () => auditBus,
        collector,
        eventBus,
      });
      await registry.ensure({
        entryId: initial.entryId,
        protocolId: initial.protocolId,
        config: initial.config,
      });

      const cancelInteraction: InteractionAPI = {
        raise: () =>
          Promise.reject(new Cancellation("user cancelled", undefined, { code: "TurnCancelled" })),
      };

      const beforeRevision = selection.revisionId();
      const beforeSettingsRaw = await readFile(globalPath, "utf8");

      await assert.rejects(
        dispatchModelCommand(
          {
            session,
            deps,
            interaction: cancelInteraction,
            auditBus,
            registry,
            projectRoot,
          },
          undefined,
        ),
        (err: unknown) => err instanceof Cancellation,
      );

      assert.equal(selection.revisionId(), beforeRevision);
      assert.equal(selection.current().modelId, "qwen3.6-plus");
      assert.equal(await readFile(globalPath, "utf8"), beforeSettingsRaw);
      assert.equal(
        captured.some((c) => c.type === "ModelSwitch" || c.type === "ModelSwitchRejected"),
        false,
        "no audit emitted on cancel",
      );
    });
  });
});
