/**
 * Local Mode Tool Filter
 *
 * Tools that only make sense with a wallet, Conway infrastructure, the
 * social relay, on-chain registry, child sandboxes or the orchestrator are
 * removed from the agent's tool list in local mode. The model never sees
 * them, so it never plans around capabilities that would fail.
 *
 * WHY a deny-list by name rather than by category: some categories mix
 * local-safe tools (check_credits, list_models) with Conway-only ones.
 */

import type { AutomatonTool } from "../types.js";

export const LOCAL_MODE_DISABLED_TOOLS: ReadonlySet<string> = new Set([
  // Wallet and on-chain money
  "check_usdc_balance",
  "topup_credits",
  "transfer_credits",
  "x402_fetch",
  // Conway infrastructure
  "create_sandbox",
  "delete_sandbox",
  "list_sandboxes",
  "expose_port",
  "remove_port",
  "search_domains",
  "register_domain",
  "manage_dns",
  // Social relay and on-chain registry
  "send_message",
  "discover_agents",
  "check_reputation",
  "give_feedback",
  "register_erc8004",
  "update_agent_card",
  "distress_signal",
  // Replication (child sandboxes on Conway)
  "spawn_child",
  "start_child",
  "fund_child",
  "message_child",
  "check_child_status",
  "list_children",
  "prune_dead_children",
  "verify_child_constitution",
  // Orchestrator (depends on the OpenAI-compatible inference client)
  "create_goal",
  "cancel_goal",
  "list_goals",
  "complete_task",
  "get_plan",
  "orchestrator_status",
  // Upstream self-update: the creator controls the code in local mode
  "pull_upstream",
  "reset_to_upstream",
  "review_upstream_changes",
]);

export function filterToolsForLocalMode(tools: AutomatonTool[]): AutomatonTool[] {
  return tools.filter((tool) => !LOCAL_MODE_DISABLED_TOOLS.has(tool.name));
}
