/**
 * Local Ledger
 *
 * USD budget for an automaton that runs without Conway credits. The balance
 * is what the survival tiers read, so spending inference tokens really does
 * bring the agent closer to "dead", and the creator funds it by hand.
 *
 * WHY: upstream derives survival from Conway's prepaid credits bought with
 * USDC. This fork replaces that with an append-only ledger in SQLite: every
 * credit and debit is a row, the balance is a SUM, and nothing is ever
 * overwritten.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { ulid } from "ulid";

export type LedgerEntryType = "credit" | "debit";

export interface LedgerEntry {
  id: string;
  type: LedgerEntryType;
  amountCents: number;
  reason: string;
  ref: string | null;
  createdAt: string;
}

export class Ledger {
  constructor(private readonly db: DatabaseType) {}

  balanceCents(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount_cents ELSE -amount_cents END), 0) AS balance
         FROM ledger_entries`,
      )
      .get() as { balance: number };
    return row.balance;
  }

  credit(amountCents: number, reason: string, ref?: string): LedgerEntry {
    return this.insert("credit", amountCents, reason, ref);
  }

  debit(amountCents: number, reason: string, ref?: string): LedgerEntry {
    return this.insert("debit", amountCents, reason, ref);
  }

  recent(limit = 50): LedgerEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM ledger_entries ORDER BY rowid DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map(deserialize);
  }

  private insert(type: LedgerEntryType, amountCents: number, reason: string, ref?: string): LedgerEntry {
    if (!Number.isInteger(amountCents) || amountCents < 0) {
      throw new Error(`Ledger amount must be a non-negative integer in cents, got ${amountCents}`);
    }
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO ledger_entries (id, type, amount_cents, reason, ref) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, type, amountCents, reason, ref ?? null);
    return deserialize(this.db.prepare("SELECT * FROM ledger_entries WHERE id = ?").get(id));
  }
}

function deserialize(row: any): LedgerEntry {
  return {
    id: row.id,
    type: row.type,
    amountCents: row.amount_cents,
    reason: row.reason,
    ref: row.ref ?? null,
    createdAt: row.created_at,
  };
}
