import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApprovalManager } from "../../../../src/extensions/ui/default-tui/ink-approval.js";
import { createComposerController } from "../../../../src/extensions/ui/default-tui/ink-composer.js";
import {
  createInputQueue,
  createStore,
} from "../../../../src/extensions/ui/default-tui/ink-store.js";

describe("default-tui composer submit echo", () => {
  function harness(): {
    typeChars: (input: string) => void;
    pressEnter: () => Promise<string>;
    echoes: string[];
  } {
    const store = createStore();
    const queue = createInputQueue();
    const approval = createApprovalManager({ store, isUnmounted: () => false });
    const echoes: string[] = [];
    const composer = createComposerController({
      store,
      queue,
      approval,
      appendUserMessage: (text) => echoes.push(text),
    });
    return {
      typeChars(input) {
        for (const ch of input) {
          composer.onKey(ch, {});
        }
      },
      async pressEnter() {
        const next = queue.enqueue();
        composer.onKey("", { return: true });
        return next;
      },
      echoes,
    };
  }

  it("echoes a default-chat message exactly once on submit", async () => {
    const h = harness();
    h.typeChars("hello world");
    const submitted = await h.pressEnter();
    assert.equal(submitted, "hello world");
    assert.deepEqual(h.echoes, ["hello world"]);
  });

  it("does not echo a slash command", async () => {
    const h = harness();
    h.typeChars("/help");
    const submitted = await h.pressEnter();
    assert.equal(submitted, "/help");
    assert.deepEqual(h.echoes, []);
  });

  it("does not echo /exit", async () => {
    const h = harness();
    h.typeChars("/exit");
    const submitted = await h.pressEnter();
    assert.equal(submitted, "/exit");
    assert.deepEqual(h.echoes, []);
  });

  it("does not echo a whitespace-only submission", async () => {
    const h = harness();
    h.typeChars("   ");
    const submitted = await h.pressEnter();
    assert.equal(submitted.trim(), "");
    assert.deepEqual(h.echoes, []);
  });

  it("does not echo an empty submission", async () => {
    const h = harness();
    const submitted = await h.pressEnter();
    assert.equal(submitted, "");
    assert.deepEqual(h.echoes, []);
  });
});
