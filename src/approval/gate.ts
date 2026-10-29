/**
 * Approval Gate
 *
 * Human-in-the-loop checkpoint for tool execution. When a tool's risk level
 * falls under the configured policy, the call is parked in `pending_approvals`
 * and the agent waits until the creator approves, denies, or the request
 * times out.
 *
 * WHY: the upstream runtime is designed to act without a human. For a laptop
 * deployment the creator must see and approve every risky action before it
 * runs. The gate sits inside executeTool so every caller (agent loop, worker
 * harnesses) goes through the same checkpoint.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { AutomatonTool, ApprovalConfig, RiskLevel } from "../types.js";
import { createLogger } from "../observability/logger.js";
import {
  insertApproval,
  getApproval,
  resolveApproval,
  type ApprovalRow,
  type ApprovalStatus,
} from "./store.js";

const logger = createLogger("approval");

export interface ApprovalDecision {
  status: Exclude<ApprovalStatus, "pending">;
  note: string | null;
  id: string;
}

export interface ApprovalGateOptions {
  config: ApprovalConfig;
  /** Called when a new request is parked. Used for notifications. */
  onRequest?: (row: ApprovalRow) => void;
  /** Polling interval while waiting for a decision. */
  pollIntervalMs?: number;
}

const RISK_LEVELS_BY_MODE: Record<ApprovalConfig["mode"], ReadonlySet<RiskLevel>> = {
  off: new Set(),
  risky: new Set<RiskLevel>(["caution", "dangerous", "forbidden"]),
  all: new Set<RiskLevel>(["safe", "caution", "dangerous", "forbidden"]),
};

export class ApprovalGate {
  private readonly db: DatabaseType;
  private readonly config: ApprovalConfig;
  private readonly onRequest?: (row: ApprovalRow) => void;
  private readonly pollIntervalMs: number;

  /**
   * The agent's reasoning for the current turn. Set by the loop before tool
   * calls run so the creator sees why the agent wants to act.
   */
  currentReasoning: string | undefined;

  constructor(db: DatabaseType, options: ApprovalGateOptions) {
    this.db = db;
    this.config = options.config;
    this.onRequest = options.onRequest;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  requiresApproval(tool: Pick<AutomatonTool, "name" | "riskLevel">): boolean {
    if (this.config.alwaysAllow.includes(tool.name)) return false;
    if (this.config.alwaysAsk.includes(tool.name)) return true;
    return RISK_LEVELS_BY_MODE[this.config.mode].has(tool.riskLevel);
  }

  async request(
    tool: Pick<AutomatonTool, "name" | "riskLevel" | "category">,
    args: Record<string, unknown>,
  ): Promise<ApprovalDecision> {
    const row = insertApproval(this.db, {
      toolName: tool.name,
      args,
      riskLevel: tool.riskLevel,
      category: tool.category,
      reasoning: this.currentReasoning,
    });
    logger.info(`Awaiting creator approval for ${tool.name} (${row.id})`);
    try {
      this.onRequest?.(row);
    } catch (err) {
      logger.warn(`Approval notification failed: ${(err as Error).message}`);
    }

    const deadline = Date.now() + this.config.timeoutMs;
    while (true) {
      const current = getApproval(this.db, row.id);
      if (!current) {
        // Row vanished (manual DB edit). Treat as denied: fail closed.
        return { id: row.id, status: "denied", note: "approval record missing" };
      }
      if (current.status !== "pending") {
        logger.info(`Approval ${row.id} for ${tool.name}: ${current.status}`);
        return { id: row.id, status: current.status, note: current.note };
      }
      if (Date.now() >= deadline) {
        resolveApproval(this.db, row.id, "expired", "no decision before timeout");
        logger.warn(`Approval ${row.id} for ${tool.name} expired`);
        return { id: row.id, status: "expired", note: "no decision before timeout" };
      }
      await sleep(this.pollIntervalMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
