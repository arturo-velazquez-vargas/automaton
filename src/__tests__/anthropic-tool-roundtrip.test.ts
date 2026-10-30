/**
 * Regression: a persisted turn with a tool call must be replayed to Anthropic
 * as an assistant `tool_use` block followed by a user `tool_result` block
 * with the same id. The router used to flatten tool results into text, which
 * the API rejects ("tool_use ids were found without tool_result blocks").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InferenceRouter } from "../inference/router.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import { createInferenceClient } from "../conway/inference.js";
import { buildContextMessages } from "../agent/context.js";
import { createTestDb } from "./mocks.js";
import type { AutomatonDatabase, AgentTurn, ChatMessage } from "../types.js";

const TOOL_ID = "toolu_01UisKVE8iznw4rEWiJeoD6A";

function turnWithToolCall(): AgentTurn {
  return {
    id: "turn-1",
    timestamp: new Date().toISOString(),
    state: "running",
    input: "You have just been created.",
    inputSource: "wakeup",
    thinking: "I'll start by checking my environment.",
    toolCalls: [
      { id: TOOL_ID, name: "exec", arguments: { command: "ls" }, result: "exit_code: 0\nstdout: workspace", durationMs: 12 },
    ],
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    costCents: 1,
  };
}

describe("router keeps tool messages intact for Anthropic", () => {
  let db: AutomatonDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("does not flatten tool results into user text", () => {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const router = new InferenceRouter(db.raw, registry, new InferenceBudgetTracker(db.raw, DEFAULT_MODEL_STRATEGY_CONFIG));
    const messages = buildContextMessages("system", [turnWithToolCall()]);
    const out = router.transformMessagesForProvider(messages, "anthropic");
    const toolMsg = out.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe(TOOL_ID);
    expect(out.some((m) => typeof m.content === "string" && m.content.includes("[tool_result:"))).toBe(false);
  });
});

describe("Anthropic request body for a replayed tool call", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("pairs every tool_use with a tool_result in the next user message", async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "msg_1", model: "claude-opus-5-5", stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as any;

    const client = createInferenceClient({
      apiUrl: "https://api.conway.tech", apiKey: "", defaultModel: "claude-opus-5-5", maxTokens: 1000,
      lowComputeModel: "claude-haiku-5-5", anthropicApiKey: "sk-ant-test",
      getModelProvider: () => "anthropic",
    });
    const messages: ChatMessage[] = buildContextMessages("system", [turnWithToolCall()], { content: "Continue.", source: "creator" });
    await client.chat(messages, { model: "claude-opus-5-5", temperature: 0.1 });

    expect(captured).not.toBeNull();
    expect(captured.temperature).toBeUndefined();
    const roles = captured.messages.map((m: any) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "user"].slice(0, roles.length));

    const assistant = captured.messages[1];
    const toolUse = assistant.content.find((b: any) => b.type === "tool_use");
    expect(toolUse.id).toBe(TOOL_ID);
    expect(toolUse.name).toBe("exec");

    const next = captured.messages[2];
    expect(Array.isArray(next.content)).toBe(true);
    expect(next.content[0]).toMatchObject({ type: "tool_result", tool_use_id: TOOL_ID });
  });
});

describe("Anthropic request body after a text-only turn", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("never ends with an assistant message", async () => {
    let captured: any = null;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "msg_2", model: "claude-opus-5-5", stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as any;

    const client = createInferenceClient({
      apiUrl: "https://api.conway.tech", apiKey: "", defaultModel: "claude-opus-5-5", maxTokens: 1000,
      lowComputeModel: "claude-haiku-5-5", anthropicApiKey: "sk-ant-test", getModelProvider: () => "anthropic",
    });
    const textOnlyTurn: AgentTurn = { ...turnWithToolCall(), id: "turn-2", toolCalls: [], thinking: "Phase 1 is finished." };
    const messages = buildContextMessages("system", [textOnlyTurn]);
    await client.chat(messages, { model: "claude-opus-5-5" });

    const last = captured.messages[captured.messages.length - 1];
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("sleep");
  });
});
