/**
 * Approval Server Tests
 *
 * Loopback dashboard: serves state, resolves approvals, refuses mutations
 * without the anti-CSRF header, and rejects double resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startApprovalServer, type ApprovalServer } from "../../approval/server.js";
import { insertApproval, getApproval } from "../../approval/store.js";
import { createTestDb } from "../mocks.js";
import type { AutomatonDatabase } from "../../types.js";

const HEADERS = { "Content-Type": "application/json", "X-Automaton-Approval": "1" };

describe("approval server", () => {
  let db: AutomatonDatabase;
  let server: ApprovalServer;

  beforeEach(async () => {
    db = createTestDb();
    server = await startApprovalServer({ db: db.raw, port: 0, getAgentState: () => "running" });
  });

  afterEach(async () => {
    await server.close();
    db.close();
  });

  it("serves the dashboard page", async () => {
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Automaton Approvals");
  });

  it("returns pending and recent approvals as JSON", async () => {
    insertApproval(db.raw, { toolName: "exec", args: { command: "ls" }, riskLevel: "dangerous", category: "vm" });
    const res = await fetch(`${server.url}/api/state`);
    const body = await res.json();
    expect(body.agentState).toBe("running");
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0].toolName).toBe("exec");
    expect(body.recent).toHaveLength(0);
  });

  it("approves with a note when the header is present", async () => {
    const row = insertApproval(db.raw, { toolName: "exec", args: {}, riskLevel: "dangerous", category: "vm" });
    const res = await fetch(`${server.url}/api/approvals/${row.id}/approve`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ note: "ok" }),
    });
    expect(res.status).toBe(200);
    const stored = getApproval(db.raw, row.id);
    expect(stored?.status).toBe("approved");
    expect(stored?.note).toBe("ok");
  });

  it("denies without a note", async () => {
    const row = insertApproval(db.raw, { toolName: "exec", args: {}, riskLevel: "dangerous", category: "vm" });
    const res = await fetch(`${server.url}/api/approvals/${row.id}/deny`, { method: "POST", headers: HEADERS });
    expect(res.status).toBe(200);
    expect(getApproval(db.raw, row.id)?.status).toBe("denied");
  });

  it("refuses mutations without the approval header", async () => {
    const row = insertApproval(db.raw, { toolName: "exec", args: {}, riskLevel: "dangerous", category: "vm" });
    const res = await fetch(`${server.url}/api/approvals/${row.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(getApproval(db.raw, row.id)?.status).toBe("pending");
  });

  it("rejects a second resolution with 409", async () => {
    const row = insertApproval(db.raw, { toolName: "exec", args: {}, riskLevel: "dangerous", category: "vm" });
    await fetch(`${server.url}/api/approvals/${row.id}/deny`, { method: "POST", headers: HEADERS });
    const res = await fetch(`${server.url}/api/approvals/${row.id}/approve`, { method: "POST", headers: HEADERS });
    expect(res.status).toBe(409);
    expect(getApproval(db.raw, row.id)?.status).toBe("denied");
  });

  it("404s unknown routes", async () => {
    const res = await fetch(`${server.url}/api/nope`);
    expect(res.status).toBe(404);
  });
});
