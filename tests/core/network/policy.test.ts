import assert from "node:assert/strict";
import { describe, it } from "node:test";

// @ts-expect-error Node test runtime imports .ts sources directly for this unit.
import { ToolTerminal } from "../../../src/core/errors/tool-terminal.ts";
// @ts-expect-error Node test runtime imports .ts sources directly for this unit.
import { Validation } from "../../../src/core/errors/validation.ts";
// @ts-expect-error Node test runtime imports .ts sources directly for this unit.
import { loadNetworkPolicy } from "../../../src/core/network/policy.ts";

describe("NetworkPolicy.check", () => {
  it("allows an exact host match", () => {
    const policy = loadNetworkPolicy([], [], [{ host: "api.example.com", scope: "project" }]);

    const result = policy.check(new URL("https://api.example.com/x"));

    assert.equal(result.allowed, true);
    assert.equal(result.matchedEntry?.host, "api.example.com");
    assert.equal(result.matchedEntry?.scope, "project");
  });

  it("allows a leading-wildcard host but not the bare parent host", () => {
    const policy = loadNetworkPolicy([], [{ host: "*.example.com", scope: "global" }], []);

    assert.equal(policy.check(new URL("https://api.example.com/")).allowed, true);
    assert.equal(policy.check(new URL("https://example.com/")).allowed, false);
  });

  it("project scope layers over global over bundled", () => {
    const policy = loadNetworkPolicy(
      [{ host: "bundled.example.com", scope: "bundled" }],
      [{ host: "global.example.com", scope: "global" }],
      [{ host: "project.example.com", scope: "project" }],
    );

    assert.deepEqual(
      policy.describe().map((entry: { host: string }) => entry.host),
      ["project.example.com", "global.example.com", "bundled.example.com"],
    );
  });

  it("denies a non-allowlisted host", () => {
    const policy = loadNetworkPolicy([], [], []);

    const result = policy.check(new URL("https://evil.example/"));

    assert.equal(result.allowed, false);
    assert.equal(result.matchedEntry, undefined);
  });

  it("matches ports when an entry constrains them", () => {
    const policy = loadNetworkPolicy(
      [],
      [],
      [{ host: "api.example.com", ports: [443], scope: "project" }],
    );

    assert.equal(policy.check(new URL("https://api.example.com/")).allowed, true);
    assert.equal(policy.check(new URL("https://api.example.com:8443/")).allowed, false);
  });

  it("matches explicit and default ports for both https and http", () => {
    const policy = loadNetworkPolicy(
      [],
      [],
      [
        { host: "secure.example.com", ports: [8443], scope: "project" },
        { host: "plain.example.com", ports: [80], scope: "project" },
      ],
    );

    assert.equal(policy.check(new URL("https://secure.example.com:8443/")).allowed, true);
    assert.equal(policy.check(new URL("http://plain.example.com/")).allowed, true);
  });

  it("de-dupes identical host and port entries by precedence", () => {
    const policy = loadNetworkPolicy(
      [{ host: "shared.example.com", ports: [443], scope: "bundled" }],
      [{ host: "shared.example.com", ports: [443], scope: "global" }],
      [{ host: "shared.example.com", ports: [443], scope: "project" }],
    );

    assert.deepEqual(policy.describe(), [
      { host: "shared.example.com", ports: [443], scope: "project" },
    ]);
  });
});

describe("NetworkPolicy.assertAllowed", () => {
  it("throws ToolTerminal/NetworkDenied on a blocked host", () => {
    const policy = loadNetworkPolicy([], [], []);

    assert.throws(
      () => policy.assertAllowed(new URL("https://evil.example/")),
      (error: unknown) => {
        assert.ok(error instanceof ToolTerminal);
        assert.equal(error.class, "ToolTerminal");
        assert.equal(error.context["code"], "NetworkDenied");
        assert.equal(error.context["host"], "evil.example");
        assert.equal(error.context["port"], 443);
        assert.equal(error.context["url"], "https://evil.example/");
        return true;
      },
    );
  });

  it("loadNetworkPolicy rejects a malformed entry with Validation/PolicyInvalid", () => {
    assert.throws(
      () => loadNetworkPolicy([], [], [{ host: "" } as never]),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.class, "Validation");
        assert.equal(error.context["code"], "PolicyInvalid");
        return true;
      },
    );
  });

  it("rejects malformed wildcard and scope values with Validation/PolicyInvalid", () => {
    assert.throws(
      () => loadNetworkPolicy([], [], [{ host: "*.", scope: "project" }]),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "PolicyInvalid");
        assert.equal(error.context["reason"], "host");
        return true;
      },
    );

    assert.throws(
      () => loadNetworkPolicy([], [], [{ host: "api.example.com", scope: "team" } as never]),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "PolicyInvalid");
        assert.equal(error.context["reason"], "scope");
        return true;
      },
    );
  });

  it("rejects malformed ports with Validation/PolicyInvalid", () => {
    assert.throws(
      () => loadNetworkPolicy([], [], [{ host: "api.example.com", ports: [0], scope: "project" }]),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "PolicyInvalid");
        assert.equal(error.context["reason"], "ports");
        return true;
      },
    );

    assert.throws(
      () =>
        loadNetworkPolicy(
          [],
          [],
          [{ host: "api.example.com", ports: "443" as never, scope: "project" }],
        ),
      (error: unknown) => {
        assert.ok(error instanceof Validation);
        assert.equal(error.context["code"], "PolicyInvalid");
        assert.equal(error.context["reason"], "ports");
        return true;
      },
    );
  });
});
