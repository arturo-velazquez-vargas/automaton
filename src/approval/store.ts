/**
 * Approval Store
 *
 * Persistence for human-in-the-loop approval requests.
 * Every tool call that requires creator approval is written here first,
 * and the agent loop blocks until the row is resolved.
 *
 * WHY: SQLite is the automaton's single source of truth. Keeping approvals
 * in the same database means the dashboard, the CLI and the runtime all see
 * the same state, and a crash never loses a pending decision.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { ulid } from "ulid";
import type { RiskLevel, ToolCategory } from "../types.js";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRow {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel: RiskLevel;
  category: ToolCategory;
  reasoning: string | null;
  status: ApprovalStatus;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export function insertApproval(
  db: DatabaseType,
  params: {
    toolName: string;
    args: Record<string, unknown>;
    riskLevel: RiskLevel;
    category: ToolCategory;
    reasoning?: string;
  },
): ApprovalRow {
  const id = ulid();
  db.prepare(
    `INSERT INTO pending_approvals (id, tool_name, args, risk_level, category, reasoning)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.toolName,
    JSON.stringify(params.args ?? {}),
    params.riskLevel,
    params.category,
    params.reasoning ?? null,
  );
  return getApproval(db, id)!;
}

export function getApproval(db: DatabaseType, id: string): ApprovalRow | undefined {
  const row = db.prepare("SELECT * FROM pending_approvals WHERE id = ?").get(id) as any | undefined;
  return row ? deserialize(row) : undefined;
}

export function listPendingApprovals(db: DatabaseType): ApprovalRow[] {
  const rows = db
    .prepare("SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as any[];
  return rows.map(deserialize);
}

export function listRecentApprovals(db: DatabaseType, limit = 50): ApprovalRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM pending_approvals WHERE status != 'pending' ORDER BY resolved_at DESC LIMIT ?",
    )
    .all(limit) as any[];
  return rows.map(deserialize);
}

/**
 * Resolve a pending approval. Returns false when the row was already
 * resolved (or does not exist), so two clicks cannot flip a decision.
 */
export function resolveApproval(
  db: DatabaseType,
  id: string,
  status: Exclude<ApprovalStatus, "pending">,
  note?: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE pending_approvals
       SET status = ?, note = ?, resolved_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    )
    .run(status, note ?? null, id);
  return result.changes === 1;
}

function deserialize(row: any): ApprovalRow {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(row.args);
  } catch {
    args = {};
  }
  return {
    id: row.id,
    toolName: row.tool_name,
    args,
    riskLevel: row.risk_level,
    category: row.category,
    reasoning: row.reasoning ?? null,
    status: row.status,
    note: row.note ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  };
}
