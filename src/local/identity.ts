/**
 * Local Identity
 *
 * An automaton in local mode has no wallet. Its identity is a stable ULID
 * persisted in the database plus the creator's name.
 *
 * WHY: identity.address is used as a display string and a database key
 * throughout the runtime, so it keeps the shape "local:<id>". The
 * `account` field exists only to satisfy the upstream type; every tool
 * that would sign with it is removed in local mode (see tool-filter.ts).
 */

import { ulid } from "ulid";
import type { PrivateKeyAccount } from "viem";
import type { AutomatonConfig, AutomatonDatabase, AutomatonIdentity } from "../types.js";

export const LOCAL_ADDRESS_PREFIX = "local:";

export function isLocalAddress(address: string | undefined): boolean {
  return typeof address === "string" && address.startsWith(LOCAL_ADDRESS_PREFIX);
}

export function createLocalIdentity(db: AutomatonDatabase, config: AutomatonConfig): AutomatonIdentity {
  const existing = db.getIdentity("automatonId");
  const automatonId = existing || ulid();
  if (!existing) db.setIdentity("automatonId", automatonId);

  const existingCreatedAt = db.getIdentity("createdAt");
  const createdAt = existingCreatedAt || new Date().toISOString();
  if (!existingCreatedAt) db.setIdentity("createdAt", createdAt);

  const address = `${LOCAL_ADDRESS_PREFIX}${automatonId}`;
  db.setIdentity("name", config.name);
  db.setIdentity("address", address);
  db.setIdentity("creator", config.creatorAddress);
  db.setIdentity("chainType", "none");
  db.setIdentity("sandbox", "");

  const account = new Proxy({} as PrivateKeyAccount, {
    get(_target, prop) {
      if (prop === "address") return address;
      throw new Error(`Wallet operation "${String(prop)}" is not available in local mode`);
    },
  });

  return {
    name: config.name,
    address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: "",
    apiKey: "",
    createdAt,
  };
}
