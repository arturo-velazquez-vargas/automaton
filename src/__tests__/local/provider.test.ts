import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalProvider } from "../../local/provider.js";
import { Ledger } from "../../local/ledger.js";
import { createTestDb } from "../mocks.js";
import type { AutomatonDatabase, ConwayClient } from "../../types.js";

describe("local provider", () => {
  let db: AutomatonDatabase;
  let workspace: string;
  let provider: ConwayClient;

  beforeEach(() => {
    db = createTestDb();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-ws-"));
    provider = createLocalProvider({ ledger: new Ledger(db.raw), workspaceDir: workspace, execTarget: { kind: "host" } });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("runs commands in the workspace and reports exit codes", async () => {
    const ok = await provider.exec("pwd");
    expect(ok.exitCode).toBe(0);
    expect(fs.realpathSync(ok.stdout.trim())).toBe(fs.realpathSync(workspace));

    const bad = await provider.exec("exit 3");
    expect(bad.exitCode).toBe(3);
  });

  it("times out long commands instead of hanging", async () => {
    const result = await provider.exec("sleep 5", 200);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });

  it("writes and reads files relative to the workspace", async () => {
    await provider.writeFile("notes/plan.md", "hello");
    expect(fs.readFileSync(path.join(workspace, "notes/plan.md"), "utf-8")).toBe("hello");
    expect(await provider.readFile("notes/plan.md")).toBe("hello");
  });

  it("reports the ledger balance as credits", async () => {
    const ledger = new Ledger(db.raw);
    ledger.credit(2500, "fund");
    expect(await provider.getCreditsBalance()).toBe(2500);
  });

  it("fails fast on Conway-only capabilities", async () => {
    await expect(provider.registerDomain("x.com")).rejects.toThrow(/not available in local mode/);
    await expect(provider.transferCredits("0xabc", 100)).rejects.toThrow(/not available in local mode/);
    await expect(provider.exposePort(8080)).rejects.toThrow(/not available in local mode/);
    expect(await provider.listSandboxes()).toEqual([]);
  });
});
