import { describe, it, expect, vi } from "vitest";
import { createBuiltinTools } from "../../agent/tools.js";
import { filterToolsForLocalMode, LOCAL_MODE_DISABLED_TOOLS } from "../../local/tool-filter.js";

vi.mock("../../registry/erc8004.js", () => ({
  queryAgent: vi.fn(),
  getTotalAgents: vi.fn().mockResolvedValue(0),
  registerAgent: vi.fn(),
  leaveFeedback: vi.fn(),
}));

describe("local mode tool filter", () => {
  it("removes wallet, Conway, social, replication and orchestrator tools", () => {
    const all = createBuiltinTools("");
    const kept = filterToolsForLocalMode(all);
    const keptNames = new Set(kept.map((t) => t.name));

    for (const name of ["exec", "read_file", "write_file", "check_credits", "edit_own_file", "git_commit", "remember_fact", "sleep", "list_models", "switch_model"]) {
      expect(keptNames.has(name), `${name} should stay`).toBe(true);
    }
    for (const name of LOCAL_MODE_DISABLED_TOOLS) {
      expect(keptNames.has(name), `${name} should be removed`).toBe(false);
    }
    expect(kept.length).toBe(all.length - all.filter((t) => LOCAL_MODE_DISABLED_TOOLS.has(t.name)).length);
  });

  it("every name in the deny-list refers to a real builtin tool", () => {
    const names = new Set(createBuiltinTools("").map((t) => t.name));
    for (const name of LOCAL_MODE_DISABLED_TOOLS) {
      expect(names.has(name), `${name} is not a builtin tool`).toBe(true);
    }
  });
});
