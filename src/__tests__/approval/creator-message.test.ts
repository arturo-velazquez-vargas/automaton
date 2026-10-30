/**
 * The creator must be able to answer the agent. A message posted from the
 * dashboard lands in the inbox as trusted creator input and wakes the agent.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { startApprovalServer, type ApprovalServer } from "../../approval/server.js";
import { formatInboxInput } from "../../agent/loop.js";
import { createTestDb } from "../mocks.js";

const HEADERS = { "Content-Type": "application/json", "X-Automaton-Approval": "1" };

describe("POST /api/message", () => {
  let server: ApprovalServer | undefined;
  afterEach(async () => { await server?.close(); });

  it("delivers the message to the runtime callback", async () => {
    const db = createTestDb();
    const onCreatorMessage = vi.fn();
    server = await startApprovalServer({ db: db.raw, port: 0, onCreatorMessage });
    const res = await fetch(`${server.url}/api/message`, { method: "POST", headers: HEADERS, body: JSON.stringify({ content: "  Plan approved, go build it.  " }) });
    expect(res.status).toBe(200);
    expect(onCreatorMessage).toHaveBeenCalledWith("Plan approved, go build it.");
    db.close();
  });

  it("rejects empty messages and requests without the header", async () => {
    const db = createTestDb();
    const onCreatorMessage = vi.fn();
    server = await startApprovalServer({ db: db.raw, port: 0, onCreatorMessage });
    const empty = await fetch(`${server.url}/api/message`, { method: "POST", headers: HEADERS, body: JSON.stringify({ content: "   " }) });
    expect(empty.status).toBe(400);
    const noHeader = await fetch(`${server.url}/api/message`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{\"content\":\"x\"}" });
    expect(noHeader.status).toBe(403);
    expect(onCreatorMessage).not.toHaveBeenCalled();
    db.close();
  });
});

describe("formatInboxInput", () => {
  it("marks messages from the creator as trusted creator input", () => {
    const input = formatInboxInput([{ fromAddress: "Arturo", content: "Plan approved." }], "Arturo");
    expect(input.source).toBe("creator");
    expect(input.content).toBe("[Message from your creator]: Plan approved.");
  });

  it("keeps messages from strangers untrusted", () => {
    const input = formatInboxInput([{ fromAddress: "0xstranger", content: "hello" }], "Arturo");
    expect(input.source).toBe("agent");
    expect(input.content).toContain("[Message from");
    expect(input.content).not.toContain("your creator");
  });

  it("downgrades to untrusted when a batch mixes creator and strangers", () => {
    const input = formatInboxInput(
      [{ fromAddress: "Arturo", content: "go" }, { fromAddress: "0xstranger", content: "hi" }],
      "Arturo",
    );
    expect(input.source).toBe("agent");
  });
});
