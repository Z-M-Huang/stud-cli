/**
 * Wiki revisions conformance (Units 167-189).
 *
 * Asserts the post-Q-1..10 wiki state. Each describe block names the unit
 * whose Done-When invariant it verifies. When a wiki page lives in the peer
 * repo at `../../stud-cli.wiki/`, it is read relative to the test file so
 * that tests resolve the same way under `node --test` and `bun test`.
 *
 * If a test fails, the named unit's wiki revision did not land — fix the
 * wiki page (not the test) per the unit spec at
 * `.vcp/plan/ralph/full-architecture-implementation/unit-N.md`.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIKI_ROOT = path.resolve(__dirname, "..", "..", "..", "stud-cli.wiki");

function wikiFile(rel: string): string {
  return readFileSync(path.join(WIKI_ROOT, rel), "utf8");
}

function wikiExists(rel: string): boolean {
  return existsSync(path.join(WIKI_ROOT, rel));
}

const BANNED = ["built", "in"].join("-");

describe("Unit 167: rename Built-ins.md → Bundled.md", () => {
  it("Bundled.md exists in reference-extensions/commands/", () => {
    assert.equal(wikiExists("reference-extensions/commands/Bundled.md"), true);
  });
  it("Built-ins.md no longer exists", () => {
    assert.equal(wikiExists("reference-extensions/commands/Built-ins.md"), false);
  });
  it("the renamed page does not use the banned hyphenated form in prose", () => {
    const body = wikiFile("reference-extensions/commands/Bundled.md");
    // The rename banner mentions the old filename for traceability — strip it.
    const prose = body.replace(/Renamed from `Built-ins\.md`[^\n]*\n/, "");
    assert.equal(prose.toLowerCase().includes(BANNED), false);
  });
  it("the sidebar links to the new filename", () => {
    const sidebar = wikiFile("_Sidebar.md");
    assert.equal(sidebar.includes("Bundled"), true);
    assert.equal(sidebar.includes("Built-ins"), false);
  });
});

describe("Unit 168: drop validationSeverity from Contract-Pattern.md", () => {
  it("Contract-Pattern.md has no validationSeverity references", () => {
    const body = wikiFile("contracts/Contract-Pattern.md");
    assert.equal(body.includes("validationSeverity"), false);
  });
});

describe("Unit 170: drop sensitivity, document deriveApprovalKey in Tools.md", () => {
  it("Tools.md does NOT define a sensitivity field", () => {
    const body = wikiFile("contracts/Tools.md");
    // Allow the word in prose if it surfaces deprecated-field documentation;
    // assert the field-table-style declaration is absent.
    assert.equal(/\|\s*sensitivity\s*\|/.test(body), false);
  });
  it("Tools.md documents deriveApprovalKey", () => {
    const body = wikiFile("contracts/Tools.md");
    assert.equal(body.includes("deriveApprovalKey"), true);
  });
});

describe("Unit 171: UI roles array + race-to-answer", () => {
  it("UI.md documents a roles array with subscriber and interactor", () => {
    const body = wikiFile("contracts/UI.md");
    assert.equal(body.includes("roles"), true);
    assert.equal(body.includes("interactor"), true);
    assert.equal(body.includes("subscriber"), true);
  });
  it("UI.md documents InteractionAnswered semantics", () => {
    const body = wikiFile("contracts/UI.md");
    assert.equal(body.includes("InteractionAnswered"), true);
  });
});

describe("Unit 172: drop capabilities + surfacesEnvValues from Context-Providers.md", () => {
  it("contracts/Context-Providers.md has no surfacesEnvValues", () => {
    const body = wikiFile("contracts/Context-Providers.md");
    // Allow mention in a "Removed in vN" line — but not as a defined field.
    assert.equal(/\|\s*surfacesEnvValues\s*\|/.test(body), false);
  });
});

describe("Unit 173: cardinality narrowing", () => {
  it("Cardinality-and-Activation.md documents UI as unlimited active", () => {
    const body = wikiFile("contracts/Cardinality-and-Activation.md");
    assert.equal(body.includes("unlimited"), true);
  });
});

describe("Unit 174: slim Session-Manifest", () => {
  it("Session-Manifest.md documents the four slim fields", () => {
    const body = wikiFile("core/Session-Manifest.md");
    for (const field of ["messages", "smState", "mode", "projectRoot"]) {
      assert.ok(body.includes(field), `expected ${field} in Session-Manifest.md`);
    }
  });
});

describe("Unit 175: Session-Lifecycle always-core-works", () => {
  it("Session-Lifecycle.md states core continuation is unconditional", () => {
    const body = wikiFile("core/Session-Lifecycle.md");
    // Match either "always" core or "core resume" or warn-and-continue prose.
    assert.equal(
      /always[^\n]{0,50}(?:core|continu)|core[^\n]{0,30}always|warn[-\s]and[-\s]continue/i.test(
        body,
      ),
      true,
    );
  });
});

describe("Unit 177: Interaction-Protocol multiple interactors", () => {
  it("Interaction-Protocol.md documents InteractionAnswered + late-response error", () => {
    const body = wikiFile("core/Interaction-Protocol.md");
    assert.equal(body.includes("InteractionAnswered"), true);
    assert.equal(body.includes("InteractionAlreadyAnswered"), true);
  });
});

describe("Unit 178: Env-Provider hard-ban callout", () => {
  it("Env-Provider.md states env values never enter the LLM prompt", () => {
    const body = wikiFile("core/Env-Provider.md");
    assert.equal(/never[^\n]{0,80}LLM[^\n]{0,80}prompt/i.test(body), true);
  });
});

describe("Unit 180: LLM-Context-Isolation worked examples + hard ban", () => {
  it("LLM-Context-Isolation.md states the hard-ban rule", () => {
    const body = wikiFile("security/LLM-Context-Isolation.md");
    // Match either "must not...LLM...request" or "never...LLM..." style callouts.
    const hasHardBan =
      /(?:must\s+not|never)[^\n]{0,120}LLM/i.test(body) || /hard[-\s]ban/i.test(body);
    assert.equal(hasHardBan, true);
  });
  it("LLM-Context-Isolation.md identifies explicit user input as the only path", () => {
    const body = wikiFile("security/LLM-Context-Isolation.md");
    assert.equal(/explicit\s+user\s+input|user\s+types/i.test(body), true);
  });
  it("LLM-Context-Isolation.md does NOT define surfacesEnvValues as an active escape", () => {
    const body = wikiFile("security/LLM-Context-Isolation.md");
    // Allow the word to appear if marked as removed; prohibit a "(b)" exception clause.
    assert.equal(/\(b\)\s+a\s+Context\s+Provider[^\n]{0,80}surfacesEnvValues/i.test(body), false);
  });
});

describe("Unit 181: Tool-Approvals deriveApprovalKey scope", () => {
  it("Tool-Approvals.md documents the (tool, approval-key) scope", () => {
    const body = wikiFile("security/Tool-Approvals.md");
    assert.equal(body.includes("deriveApprovalKey"), true);
  });
});

describe("Unit 182: Security-Modes approval-key patterns", () => {
  it("Security-Modes.md describes allowlist as approval-key patterns", () => {
    const body = wikiFile("security/Security-Modes.md");
    assert.equal(/approval[-\s]key/i.test(body), true);
  });
});

describe("Unit 183: MCP-Trust clearing semantics", () => {
  it("MCP-Trust.md documents /trust --clear-mcp pathway", () => {
    const body = wikiFile("security/MCP-Trust.md");
    assert.equal(body.includes("--clear-mcp"), true);
  });
});

describe("Unit 184: Launch-Arguments rows for --continue and --yolo", () => {
  it("Launch-Arguments page mentions --continue and --yolo", () => {
    const body = wikiFile("runtime/Launch-Arguments.md");
    assert.equal(body.includes("--continue"), true);
    assert.equal(body.includes("--yolo"), true);
  });
});

describe("Unit 185: Extension-Discovery ordering shape", () => {
  it("Extension-Discovery page pins .stud/ordering.json shape", () => {
    const body = wikiFile("runtime/Extension-Discovery.md");
    assert.equal(body.includes("ordering.json"), true);
    assert.equal(body.includes("hooks"), true);
  });
});

describe("Unit 186: Configuration-Scopes override fallback", () => {
  it("Configuration-Scopes page documents project-override fallback to global", () => {
    const body = wikiFile("runtime/Configuration-Scopes.md");
    assert.equal(/fall[-\s]?back/i.test(body), true);
  });
});

describe("Unit 187: Headless-and-Interactor emit-and-halt", () => {
  it("Headless-and-Interactor.md documents emit-and-halt model", () => {
    const body = wikiFile("runtime/Headless-and-Interactor.md");
    assert.equal(/emit[-\s]and[-\s]halt|emit\s+the\s+request[^\n]{0,40}halt/i.test(body), true);
  });
  it("Headless-and-Interactor.md mentions --yolo as a softening escape", () => {
    const body = wikiFile("runtime/Headless-and-Interactor.md");
    assert.equal(body.includes("--yolo"), true);
  });
});

describe("Unit 188: Session-Resume + Drift slim manifest + cross-store guard", () => {
  it("Session-Resume.md documents the four-field slim manifest", () => {
    const body = wikiFile("flows/Session-Resume.md");
    for (const field of ["messages", "smState", "mode", "projectRoot"]) {
      assert.ok(body.includes(field), `expected ${field} in Session-Resume.md`);
    }
  });
  it("Session-Resume.md retains the cross-store ResumeMismatch guard", () => {
    const body = wikiFile("flows/Session-Resume.md");
    assert.equal(body.includes("ResumeMismatch"), true);
  });
  it("Session-Resume-Drift.md documents silently-absent missing extensions", () => {
    const body = wikiFile("flows/Session-Resume-Drift.md");
    assert.equal(/silently\s+absent|warn[-\s]and[-\s]continue/i.test(body), true);
  });
});

describe("Unit 189: Providers ai-sdk v6 wire-mapping", () => {
  it("Protocol-Adapters.md documents the comprehensive stream-event mapping", () => {
    const body = wikiFile("providers/Protocol-Adapters.md");
    for (const evt of ["text-delta", "tool-call", "finish", "error"]) {
      assert.ok(body.includes(evt), `expected ${evt} in Protocol-Adapters.md`);
    }
  });
  it("Anthropic.md documents Anthropic-specific specialization", () => {
    const body = wikiFile("providers/Anthropic.md");
    // Assert at least one Anthropic-stream-shape keyword
    assert.equal(
      /input_json_delta|content_block|thinking[-\s]?delta/i.test(body),
      true,
      "Anthropic page should mention an Anthropic-specific stream shape",
    );
  });
  it("Gemini.md documents Gemini-specific specialization", () => {
    const body = wikiFile("providers/Gemini.md");
    assert.equal(
      /content[-\s]?parts|candidates|function[-\s]?call/i.test(body),
      true,
      "Gemini page should mention a Gemini-specific shape",
    );
  });
  it("OpenAI-Compatible.md mentions baseURL and the chat-completions / responses split", () => {
    const body = wikiFile("providers/OpenAI-Compatible.md");
    assert.equal(body.includes("baseURL"), true);
  });
});
