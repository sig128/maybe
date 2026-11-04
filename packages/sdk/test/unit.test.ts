import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import vaultIdl from "../src/idl/maybe_vault.json" with { type: "json" };
import venueIdl from "../src/idl/maybe_testvenue.json" with { type: "json" };
import { accountDisc, attestationMessage, eventDisc, ixDisc, vaultErrorName, LOCALNET_PROGRAM_IDS, Pdas } from "../src/index.ts";

type Idl = { address: string; instructions: Array<{ name: string; discriminator: number[] }>; accounts?: Array<{ name: string; discriminator: number[] }>; events?: Array<{ name: string; discriminator: number[] }> };

describe("SDK ↔ IDL agreement (no validator needed)", () => {
  it("program IDs match the generated IDLs", () => {
    expect((vaultIdl as Idl).address).toBe(LOCALNET_PROGRAM_IDS.vault.toBase58());
    expect((venueIdl as Idl).address).toBe(LOCALNET_PROGRAM_IDS.venue.toBase58());
  });
  it("instruction, account and event discriminators match the IDL", () => {
    for (const idl of [vaultIdl, venueIdl] as Idl[]) {
      for (const ix of idl.instructions) expect([...ixDisc(ix.name)]).toEqual(ix.discriminator);
      for (const a of idl.accounts ?? []) expect([...accountDisc(a.name)]).toEqual(a.discriminator);
      for (const e of idl.events ?? []) expect([...eventDisc(e.name)]).toEqual(e.discriminator);
    }
  });
  it("error codes resolve to names", () => {
    expect(vaultErrorName(6000)).toBe("BadMagic");
    expect(vaultErrorName(6034)).toBe("RouteDeltaViolation");
    expect(vaultErrorName(6051)).toBe("ForeignVaultAccountInRoute");
  });
  it("attestation message is domain-separated and 136 bytes", () => {
    const k = new PublicKey("11111111111111111111111111111112");
    const m = attestationMessage({ programId: LOCALNET_PROGRAM_IDS.vault, event: k, ruleHash: new Uint8Array(32), outcome: 1, observedAt: 1, nonce: 2n, expiresAt: 3 });
    expect(m.length).toBe(136);
    expect(m.subarray(0, 15).toString()).toBe("MAYBE_ATTEST_V1");
  });
  it("PDAs are deterministic", () => {
    const p = new Pdas();
    const owner = new PublicKey("11111111111111111111111111111112");
    expect(p.vault(owner, 0n).equals(p.vault(owner, 0))).toBe(true);
    expect(p.vault(owner, 0n).equals(p.vault(owner, 1n))).toBe(false);
  });
});
