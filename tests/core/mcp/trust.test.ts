import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { Session } from "../../../src/core/errors/session.js";
import { clearRegistry, registerServer } from "../../../src/core/mcp/server-registry.js";
import { checkTrust, clearTrust, grantTrust, listTrusted } from "../../../src/core/mcp/trust.js";

const fixtureDirs = new Set<string>();
const originalHome = process.env["HOME"];

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stud-mcp-trust-"));
  fixtureDirs.add(dir);
  process.env["HOME"] = dir;
  return dir;
}

function registerFixtureServer(id: string, scope: "bundled" | "global" | "project"): void {
  registerServer({
    id,
    transport: "stdio",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    scope,
  });
}

async function readGlobalTrustFile(
  homeDir: string,
): Promise<{ serverId: string; decision: string }[]> {
  return JSON.parse(await readFile(join(homeDir, ".stud", "mcp-trust.json"), "utf8")) as {
    serverId: string;
    decision: string;
  }[];
}

async function readProjectTrustFile(): Promise<{ serverId: string }[]> {
  return JSON.parse(await readFile(join(process.cwd(), ".stud", "mcp-trust.json"), "utf8")) as {
    serverId: string;
  }[];
}

async function readTrustFileOrEmpty(
  filePath: string,
): Promise<{ serverId: string; decision?: string }[]> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as {
      serverId: string;
      decision?: string;
    }[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function grantProjectTrust(homeDir: string): Promise<void> {
  const projectRoot = join(process.cwd(), ".stud");
  const trustPath = join(homeDir, ".stud", "trust.json");
  await mkdir(join(homeDir, ".stud"), { recursive: true });
  await writeFile(
    trustPath,
    JSON.stringify([
      { canonicalPath: projectRoot, grantedAt: new Date().toISOString(), kind: "project" },
    ]),
    "utf8",
  );
}

async function expectProjectTrustRequired(id: string): Promise<void> {
  await assert.rejects(
    () => grantTrust(id, "project"),
    (error: unknown) => {
      assert.ok(error instanceof Session);
      assert.equal(error.class, "Session");
      assert.equal(error.context["code"], "ProjectTrustRequired");
      return true;
    },
  );
}

async function expectUnknownServer(): Promise<void> {
  await assert.rejects(
    () => grantTrust("ghost", "global"),
    (error: unknown) => {
      assert.equal((error as { class?: string }).class, "Validation");
      assert.equal(
        (error as { context?: { code?: string } }).context?.code,
        "MCPServerNotRegistered",
      );
      return true;
    },
  );
}

afterEach(async () => {
  clearRegistry();
  process.env["HOME"] = originalHome;
  await rm(join(process.cwd(), ".stud", "mcp-trust.json"), { force: true });
  await rm(join(process.cwd(), ".stud", "mcp-trust.json.tmp"), { force: true });

  await Promise.all(
    [...fixtureDirs].map(async (dir) => {
      fixtureDirs.delete(dir);
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("MCP trust", () => {
  it("returns unknown for a never-seen server (triggers first-run prompt upstream)", async () => {
    await createTempHome();
    registerFixtureServer("brand-new", "global");

    assert.equal(await checkTrust("brand-new"), "unknown");
  });

  it("grants trust and persists the entry", async () => {
    const homeDir = await createTempHome();
    registerFixtureServer("srv-1", "global");

    await grantTrust("srv-1", "global");

    assert.equal(await checkTrust("srv-1"), "trusted");

    const persisted = await readGlobalTrustFile(homeDir);
    assert.deepEqual(
      persisted.map((entry) => entry.serverId),
      ["srv-1"],
    );
    assert.deepEqual(
      persisted.map((entry) => entry.decision),
      ["trusted"],
    );
  });

  it("clears trust by forgetting (next check returns unknown)", async () => {
    await createTempHome();
    registerFixtureServer("srv-2", "global");

    await grantTrust("srv-2", "global");
    await clearTrust("srv-2");

    assert.equal(await checkTrust("srv-2"), "unknown");
    assert.deepEqual(await listTrusted(), []);
  });

  it("returns trusted for bundled servers without a persisted trust entry", async () => {
    const homeDir = await createTempHome();
    registerFixtureServer("bundled-srv", "bundled");

    assert.equal(await checkTrust("bundled-srv"), "trusted");
    assert.deepEqual(await readTrustFileOrEmpty(join(homeDir, ".stud", "mcp-trust.json")), []);
  });

  it("listTrusted returns deterministic ordering", async () => {
    await createTempHome();
    registerFixtureServer("zeta", "global");
    registerFixtureServer("alpha", "global");

    await grantTrust("zeta", "global");
    await grantTrust("alpha", "global");

    const list = await listTrusted();
    assert.deepEqual(
      list.map((entry) => entry.serverId),
      ["alpha", "zeta"],
    );
  });
});

describe("MCP trust — project scope rules", () => {
  it("refuses project-scope grant without prior project trust", async () => {
    await createTempHome();
    registerFixtureServer("srv-3", "project");

    await expectProjectTrustRequired("srv-3");
  });

  it("throws Validation/MCPServerNotRegistered for unknown serverId", async () => {
    await createTempHome();
    await expectUnknownServer();
  });

  it("allows project-scope grant when prior project trust exists", async () => {
    const homeDir = await createTempHome();
    await grantProjectTrust(homeDir);
    registerFixtureServer("srv-project", "project");

    await grantTrust("srv-project", "project");

    assert.equal(await checkTrust("srv-project"), "trusted");
    const persisted = await readProjectTrustFile();
    assert.deepEqual(
      persisted.map((entry) => entry.serverId),
      ["srv-project"],
    );
  });

  it("clears trust from both global and project scopes", async () => {
    const homeDir = await createTempHome();
    await grantProjectTrust(homeDir);
    registerFixtureServer("srv-both", "global");

    await grantTrust("srv-both", "global");
    await grantTrust("srv-both", "project");
    await clearTrust("srv-both");

    assert.equal(await checkTrust("srv-both"), "unknown");
    assert.deepEqual(await readTrustFileOrEmpty(join(homeDir, ".stud", "mcp-trust.json")), []);
    assert.deepEqual(
      await readTrustFileOrEmpty(join(process.cwd(), ".stud", "mcp-trust.json")),
      [],
    );
  });
});

describe("MCP trust — file/store error handling", () => {
  it("throws Session/MCPTrustUnavailable for malformed trust JSON", async () => {
    const homeDir = await createTempHome();
    registerFixtureServer("srv-malformed", "global");
    await mkdir(join(homeDir, ".stud"), { recursive: true });
    await writeFile(join(homeDir, ".stud", "mcp-trust.json"), "{not-json", "utf8");

    await assert.rejects(
      () => checkTrust("srv-malformed"),
      (error: unknown) => {
        assert.ok(error instanceof Session);
        assert.equal(error.class, "Session");
        assert.equal(error.context["code"], "MCPTrustUnavailable");
        return true;
      },
    );
  });

  it("throws Session/MCPTrustUnavailable when the global trust file contains a JSON object (not an array)", async () => {
    const homeDir = await createTempHome();
    registerFixtureServer("srv-not-array", "global");
    await mkdir(join(homeDir, ".stud"), { recursive: true });
    await writeFile(join(homeDir, ".stud", "mcp-trust.json"), "{}", "utf8");

    let caught: unknown;
    try {
      await checkTrust("srv-not-array");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Session);
    assert.equal(caught.context["code"], "MCPTrustUnavailable");
    assert.equal(caught.context["scope"], "global");
  });

  it("throws Session/MCPTrustUnavailable when reading the trust file errors (not ENOENT)", async () => {
    const homeDir = await createTempHome();
    registerFixtureServer("srv-eisdir", "global");
    // Make the trust file path actually be a directory — read will fail with EISDIR.
    await mkdir(join(homeDir, ".stud", "mcp-trust.json"), { recursive: true });

    let caught: unknown;
    try {
      await checkTrust("srv-eisdir");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Session);
    assert.equal(caught.context["code"], "MCPTrustUnavailable");
  });

  it("throws Session/MCPTrustUnavailable when atomicWrite fails (target directory is unwritable)", async () => {
    const homeDir = await createTempHome();
    registerFixtureServer("srv-blocked", "global");
    // Plant a *file* where the .stud directory should be — mkdir will fail with EEXIST/ENOTDIR.
    await writeFile(join(homeDir, ".stud"), "blocking-file", "utf8");

    let caught: unknown;
    try {
      await grantTrust("srv-blocked", "global");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Session);
    assert.equal(caught.context["code"], "MCPTrustUnavailable");
  });
});

describe("MCP trust — project-trust gate errors", () => {
  it("throws ProjectTrustRequired when global project-grant file contains malformed JSON", async () => {
    const homeDir = await createTempHome();
    registerFixtureServer("srv-pt-malformed", "project");
    await mkdir(join(homeDir, ".stud"), { recursive: true });
    await writeFile(join(homeDir, ".stud", "trust.json"), "{not-json", "utf8");

    let caught: unknown;
    try {
      await grantTrust("srv-pt-malformed", "project");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Session);
    assert.equal(caught.context["code"], "ProjectTrustRequired");
  });

  it("throws ProjectTrustRequired when the project-grant file does not include this project root", async () => {
    const homeDir = await createTempHome();
    registerFixtureServer("srv-other-project", "project");
    await mkdir(join(homeDir, ".stud"), { recursive: true });
    await writeFile(
      join(homeDir, ".stud", "trust.json"),
      JSON.stringify([
        { canonicalPath: "/some/other/project/.stud", grantedAt: new Date().toISOString() },
      ]),
      "utf8",
    );

    let caught: unknown;
    try {
      await grantTrust("srv-other-project", "project");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Session);
    assert.equal(caught.context["code"], "ProjectTrustRequired");
  });

  it("throws ProjectTrustRequired when project-grant file contains a non-array JSON shape", async () => {
    const homeDir = await createTempHome();
    registerFixtureServer("srv-pt-not-array", "project");
    await mkdir(join(homeDir, ".stud"), { recursive: true });
    await writeFile(join(homeDir, ".stud", "trust.json"), "{}", "utf8");

    let caught: unknown;
    try {
      await grantTrust("srv-pt-not-array", "project");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Session);
    assert.equal(caught.context["code"], "ProjectTrustRequired");
  });

  it("sortEntries breaks ties by scope and grantedAt for entries sharing a serverId", async () => {
    const homeDir = await createTempHome();
    await grantProjectTrust(homeDir);
    registerFixtureServer("srv-tied", "global");

    await grantTrust("srv-tied", "global");
    await grantTrust("srv-tied", "project");

    const list = await listTrusted();
    // Two entries with the same id but different scope; deterministic order.
    assert.equal(list.length, 2);
    assert.equal(list[0]?.serverId, "srv-tied");
    assert.equal(list[1]?.serverId, "srv-tied");
    // 'global' < 'project' lexicographically
    assert.equal(list[0]?.scope, "global");
    assert.equal(list[1]?.scope, "project");
  });
});
