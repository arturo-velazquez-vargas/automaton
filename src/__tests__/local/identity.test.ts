import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createLocalIdentity, isLocalAddress } from "../../local/identity.js";
import { getUsdcBalance } from "../../conway/x402.js";
import { createTestDb, createTestConfig } from "../mocks.js";
import type { AutomatonDatabase } from "../../types.js";

describe("local identity", () => {
  let db: AutomatonDatabase;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("is stable across restarts and has no wallet", () => {
    const config = createTestConfig({ runtimeMode: "local", creatorAddress: "Arturo" });
    const first = createLocalIdentity(db, config);
    const second = createLocalIdentity(db, config);
    expect(first.address).toBe(second.address);
    expect(isLocalAddress(first.address)).toBe(true);
    expect(first.creatorAddress).toBe("Arturo");
    expect(first.account.address).toBe(first.address);
    expect(() => (first.account as any).signMessage).toThrow(/not available in local mode/);
  });

  it("never queries the chain for a local address", async () => {
    expect(await getUsdcBalance("local:01ABC")).toBe(0);
  });
});
