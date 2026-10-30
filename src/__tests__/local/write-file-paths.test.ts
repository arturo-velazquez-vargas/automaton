/**
 * In local mode write_file confines writes to the creator's real home and
 * resolves relative paths against the agent workspace, so "workspace/PLAN.md"
 * lands where `ls` in exec shows it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { createBuiltinTools } from "../../agent/tools.js";
import { MockInferenceClient, MockConwayClient, createTestDb, createTestIdentity, createTestConfig } from "../mocks.js";
import type { AutomatonDatabase, ToolContext, AutomatonTool } from "../../types.js";

vi.mock("../../registry/erc8004.js", () => ({
  queryAgent: vi.fn(), getTotalAgents: vi.fn().mockResolvedValue(0), registerAgent: vi.fn(), leaveFeedback: vi.fn(),
}));

describe("write_file paths in local mode", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let context: ToolContext;
  let writeFile: AutomatonTool;
  const home = os.homedir();
  const workspace = path.join(home, ".automaton", "workspace");

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    context = {
      identity: createTestIdentity(),
      config: createTestConfig({ runtimeMode: "local", local: { workspaceDir: "~/.automaton/workspace", execTarget: "host" } }),
      db, conway, inference: new MockInferenceClient(),
    };
    writeFile = createBuiltinTools("").find((t) => t.name === "write_file")!;
  });
  afterEach(() => { db.close(); });

  it("resolves relative paths against the workspace", async () => {
    const result = await writeFile.execute({ path: "PLAN.md", content: "x" }, context);
    expect(result).toBe(`File written: ${path.join(workspace, "PLAN.md")}`);
  });

  it("resolves ~ against the real home", async () => {
    const result = await writeFile.execute({ path: "~/notes/a.md", content: "x" }, context);
    expect(result).toBe(`File written: ${path.join(home, "notes/a.md")}`);
  });

  it("allows absolute paths inside the home", async () => {
    const target = path.join(home, "Development", "x.txt");
    const result = await writeFile.execute({ path: target, content: "x" }, context);
    expect(result).toBe(`File written: ${target}`);
  });

  it("blocks paths outside the home", async () => {
    const result = await writeFile.execute({ path: "/etc/hosts", content: "x" }, context);
    expect(result).toContain("Blocked");
    const traversal = await writeFile.execute({ path: "../../../../../../etc/hosts", content: "x" }, context);
    expect(traversal).toContain("Blocked");
  });
});
