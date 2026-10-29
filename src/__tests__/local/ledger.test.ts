import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Ledger } from "../../local/ledger.js";
import { createTestDb } from "../mocks.js";
import type { AutomatonDatabase } from "../../types.js";

describe("Ledger", () => {
  let db: AutomatonDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("starts at zero and sums credits minus debits", () => {
    const ledger = new Ledger(db.raw);
    expect(ledger.balanceCents()).toBe(0);
    ledger.credit(1000, "initial budget", "setup");
    ledger.debit(37, "inference", "turn-1");
    ledger.debit(3, "inference", "turn-2");
    expect(ledger.balanceCents()).toBe(960);
  });

  it("can go negative, which maps to the dead tier upstream", () => {
    const ledger = new Ledger(db.raw);
    ledger.credit(5, "tiny");
    ledger.debit(10, "inference");
    expect(ledger.balanceCents()).toBe(-5);
  });

  it("rejects non-integer or negative amounts", () => {
    const ledger = new Ledger(db.raw);
    expect(() => ledger.credit(1.5, "x")).toThrow();
    expect(() => ledger.debit(-1, "x")).toThrow();
  });

  it("lists recent entries newest first", () => {
    const ledger = new Ledger(db.raw);
    ledger.credit(100, "a");
    ledger.debit(1, "b");
    const recent = ledger.recent(10);
    expect(recent.map((e) => e.reason)).toEqual(["b", "a"]);
    expect(recent[0].type).toBe("debit");
  });
});
