/**
 * Approval Gate Tests
 *
 * The gate must: decide correctly which tools need approval, block until the
 * creator resolves the request, fail closed on deny/expire, and keep
 * executeTool from running a tool the creator rejected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApprovalGate } from "../../approval/gate.js";
import {
  insertApproval,
  getApproval,
  listPendingApprovals,
  listRecentApprovals,
  resolveApproval,
} from "../../approval/store.js";
import { executeTool } from "../../agent/tools.js";
import {
  MockInferenceClient,
  MockConwayClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "../mocks.js";
import type { AutomatonDatabase, AutomatonTool, ToolContext, ApprovalConfig } from "../../types.js";
import { DEFAULT_APPROVAL_CONFIG } from "../../types.js";

vi.mock("../../registry/erc8004.js", () => ({
  queryAgent: vi.fn(),
  getTotalAgents: vi.fn().mockResolvedValue(0),
  registerAgent: vi.fn(),
  leaveFeedback: vi.fn(),
}));

function makeTool(overrides: Partial<AutomatonTool>): AutomatonTool {
  return {
    name: "demo_tool",
    description: "demo",
    parameters: { type: "object", properties: {} },
    category: "vm",
    riskLevel: "dangerous",
    execute: async () => "executed",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ApprovalConfig> = {}): ApprovalConfig {
  return { ...DEFAULT_APPROVAL_CONFIG, timeoutMs: 2_000, ...overrides };
}

describe("ApprovalGate.requiresApproval", () => {
  let db: AutomatonDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("mode risky asks for caution and dangerous, not safe", () => {
    const gate = new ApprovalGate(db.raw, { config: makeConfig({ mode: "risky" }) });
    expect(gate.requiresApproval(makeTool({ riskLevel: "safe" }))).toBe(false);
    expect(gate.requiresApproval(makeTool({ riskLevel: "caution" }))).toBe(true);
    expect(gate.requiresApproval(makeTool({ riskLevel: "dangerous" }))).toBe(true);
  });

  it("mode all asks for everything, mode off asks for nothing", () => {
    const all = new ApprovalGate(db.raw, { config: makeConfig({ mode: "all" }) });
    const off = new ApprovalGate(db.raw, { config: makeConfig({ mode: "off" }) });
    expect(all.requiresApproval(makeTool({ riskLevel: "safe" }))).toBe(true);
    expect(off.requiresApproval(makeTool({ riskLevel: "dangerous" }))).toBe(false);
  });

  it("alwaysAllow and alwaysAsk override the mode", () => {
    const gate = new ApprovalGate(db.raw, {
      config: makeConfig({ mode: "risky", alwaysAllow: ["exec"], alwaysAsk: ["read_file"] }),
    });
    expect(gate.requiresApproval(makeTool({ name: "exec", riskLevel: "dangerous" }))).toBe(false);
    expect(gate.requiresApproval(makeTool({ name: "read_file", riskLevel: "safe" }))).toBe(true);
  });
});

describe("ApprovalGate.request", () => {
  let db: AutomatonDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("parks the request, notifies, and resolves when approved", async () => {
    const onRequest = vi.fn();
    const gate = new ApprovalGate(db.raw, { config: makeConfig(), onRequest, pollIntervalMs: 20 });
    gate.currentReasoning = "I need to list files";

    const pending = gate.request(makeTool({ name: "exec" }), { command: "ls" });
    await new Promise((r) => setTimeout(r, 30));

    const rows = listPendingApprovals(db.raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].toolName).toBe("exec");
    expect(rows[0].args).toEqual({ command: "ls" });
    expect(rows[0].reasoning).toBe("I need to list files");
    expect(onRequest).toHaveBeenCalledTimes(1);

    expect(resolveApproval(db.raw, rows[0].id, "approved", "go ahead")).toBe(true);
    const decision = await pending;
    expect(decision.status).toBe("approved");
    expect(decision.note).toBe("go ahead");
    expect(listPendingApprovals(db.raw)).toHaveLength(0);
    expect(listRecentApprovals(db.raw)[0].status).toBe("approved");
  });

  it("returns denied with the creator's note", async () => {
    const gate = new ApprovalGate(db.raw, { config: makeConfig(), pollIntervalMs: 20 });
    const pending = gate.request(makeTool(), {});
    await new Promise((r) => setTimeout(r, 30));
    const [row] = listPendingApprovals(db.raw);
    resolveApproval(db.raw, row.id, "denied", "not now");
    const decision = await pending;
    expect(decision.status).toBe("denied");
    expect(decision.note).toBe("not now");
  });

  it("expires when nobody answers before the timeout", async () => {
    const gate = new ApprovalGate(db.raw, { config: makeConfig({ timeoutMs: 100 }), pollIntervalMs: 20 });
    const decision = await gate.request(makeTool(), {});
    expect(decision.status).toBe("expired");
    expect(getApproval(db.raw, decision.id)?.status).toBe("expired");
  });

  it("a resolved approval cannot be flipped", () => {
    const row = insertApproval(db.raw, { toolName: "x", args: {}, riskLevel: "caution", category: "vm" });
    expect(resolveApproval(db.raw, row.id, "denied")).toBe(true);
    expect(resolveApproval(db.raw, row.id, "approved")).toBe(false);
    expect(getApproval(db.raw, row.id)?.status).toBe("denied");
  });
});

describe("executeTool with approval gate", () => {
  let db: AutomatonDatabase;
  let context: ToolContext;

  beforeEach(() => {
    db = createTestDb();
    context = {
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    };
  });
  afterEach(() => { db.close(); });

  it("does not execute a denied tool and reports the note to the agent", async () => {
    const execute = vi.fn(async () => "should not run");
    const tool = makeTool({ name: "risky_thing", execute });
    const gate = new ApprovalGate(db.raw, { config: makeConfig(), pollIntervalMs: 20 });
    context.approvalGate = gate;

    const pending = executeTool("risky_thing", { a: 1 }, [tool], context);
    await new Promise((r) => setTimeout(r, 30));
    const [row] = listPendingApprovals(db.raw);
    resolveApproval(db.raw, row.id, "denied", "too risky");

    const result = await pending;
    expect(execute).not.toHaveBeenCalled();
    expect(result.error).toBe("Creator denied this action: too risky");
  });

  it("executes an approved tool", async () => {
    const execute = vi.fn(async () => "ran");
    const tool = makeTool({ name: "risky_thing", execute });
    context.approvalGate = new ApprovalGate(db.raw, { config: makeConfig(), pollIntervalMs: 20 });

    const pending = executeTool("risky_thing", {}, [tool], context);
    await new Promise((r) => setTimeout(r, 30));
    const [row] = listPendingApprovals(db.raw);
    resolveApproval(db.raw, row.id, "approved");

    const result = await pending;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.result).toBe("ran");
    expect(result.error).toBeUndefined();
  });

  it("safe tools skip the gate entirely", async () => {
    const execute = vi.fn(async () => "ran");
    const tool = makeTool({ name: "safe_thing", riskLevel: "safe", execute });
    context.approvalGate = new ApprovalGate(db.raw, { config: makeConfig(), pollIntervalMs: 20 });

    const result = await executeTool("safe_thing", {}, [tool], context);
    expect(result.result).toBe("ran");
    expect(listPendingApprovals(db.raw)).toHaveLength(0);
    expect(listRecentApprovals(db.raw)).toHaveLength(0);
  });
});
