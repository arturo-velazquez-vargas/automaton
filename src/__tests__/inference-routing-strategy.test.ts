/**
 * Routing must honor the creator's configured models before the hardcoded
 * OpenAI matrix, otherwise an Anthropic-only setup routes to a provider
 * with no key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InferenceRouter } from "../inference/router.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../inference/types.js";
import { createTestDb } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

describe("router model selection with configured strategy", () => {
  let db: AutomatonDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  function makeRouter(overrides: Partial<typeof DEFAULT_MODEL_STRATEGY_CONFIG> = {}) {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const budget = new InferenceBudgetTracker(db.raw, { ...DEFAULT_MODEL_STRATEGY_CONFIG, ...overrides });
    return new InferenceRouter(db.raw, registry, budget);
  }

  it("defaults to Claude Opus for normal tiers and Haiku for starved tiers", () => {
    const router = makeRouter();
    expect(router.selectModel("high", "agent_turn")?.modelId).toBe("claude-opus-5-5");
    expect(router.selectModel("normal", "agent_turn")?.modelId).toBe("claude-opus-5-5");
    expect(router.selectModel("low_compute", "agent_turn")?.modelId).toBe("claude-haiku-5-5");
    expect(router.selectModel("critical", "agent_turn")?.modelId).toBe("claude-haiku-5-5");
  });

  it("follows an explicit OpenAI strategy when the creator configured one", () => {
    const router = makeRouter({ inferenceModel: "gpt-5.2", lowComputeModel: "gpt-5-mini", criticalModel: "gpt-5-mini" });
    expect(router.selectModel("normal", "agent_turn")?.modelId).toBe("gpt-5.2");
    expect(router.selectModel("low_compute", "agent_turn")?.modelId).toBe("gpt-5-mini");
  });

  it("falls back to the matrix when the configured model is unknown", () => {
    const router = makeRouter({ inferenceModel: "does-not-exist" });
    expect(router.selectModel("normal", "agent_turn")?.modelId).toBe("gpt-5.2");
  });

  it("seeds Claude models with Anthropic pricing", () => {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    expect(registry.getCostPer1k("claude-opus-5-5")).toEqual({ input: 40, output: 200 });
    expect(registry.getCostPer1k("claude-haiku-5-5")).toEqual({ input: 1, output: 5 });
    expect(registry.get("claude-opus-5-5")?.provider).toBe("anthropic");
  });
});
