import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

/** Localnet program IDs (docs/INTERFACE_CONTRACT.md §2). Override via ProgramIds for other clusters. */
export interface ProgramIds {
  vault: PublicKey;
  venue: PublicKey;
}

export const LOCALNET_PROGRAM_IDS: ProgramIds = {
  vault: new PublicKey("pUZiiWnMzroxAxPDJsjH337T5Fm9WNy92EiLNFGHgyy"),
  venue: new PublicKey("4Na5xvms9PXcE7KYq97juhzznM9jsKQ5dgSJxfR4pHDJ"),
};

export { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, SYSVAR_INSTRUCTIONS_PUBKEY };
export const SYSTEM_PROGRAM_ID = SystemProgram.programId;

export const ADAPTER_ATTESTATION = 1;
export const ADAPTER_BALANCE = 2;
export const VENUE_CODE: Record<string, number> = { "maybe-local": 1, solana: 2, polymarket: 3, kalshi: 4 };
export const ROUTE_KIND = { CP_SWAP: 1, OUTCOME_BUY: 2, OUTCOME_REDEEM: 3 } as const;
export const POOL_MODE = { HONEST: 0, OVERSPEND: 1, UNDERDELIVER: 2, REDIRECT: 3, TOUCH_OTHER: 4 } as const;

const le64 = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

export class Pdas {
  constructor(public ids: ProgramIds = LOCALNET_PROGRAM_IDS) {}
  private find(seeds: Array<Buffer | Uint8Array>, program = this.ids.vault): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, program)[0];
  }
  config() {
    return this.find([Buffer.from("config")]);
  }
  vault(owner: PublicKey, vaultId: bigint | number = 0n) {
    return this.find([Buffer.from("vault"), owner.toBuffer(), le64(vaultId)]);
  }
  strategy(vault: PublicKey, strategyId: bigint | number) {
    return this.find([Buffer.from("strategy"), vault.toBuffer(), le64(strategyId)]);
  }
  policy(vault: PublicKey, sessionKey: PublicKey) {
    return this.find([Buffer.from("policy"), vault.toBuffer(), sessionKey.toBuffer()]);
  }
  attestorSet(setId: bigint | number) {
    return this.find([Buffer.from("attestors"), le64(setId)]);
  }
  event(adapter: number, marketIdHash: Uint8Array, ruleHash: Uint8Array, binding: PublicKey) {
    return this.find([Buffer.from("event"), Buffer.from([adapter]), Buffer.from(marketIdHash), Buffer.from(ruleHash), binding.toBuffer()]);
  }
  pool(poolId: bigint | number) {
    return this.find([Buffer.from("pool"), le64(poolId)], this.ids.venue);
  }
  outcomeMarket(event: PublicKey) {
    return this.find([Buffer.from("outcome"), event.toBuffer()], this.ids.venue);
  }
}

/** Associated token account (owners may be PDAs). */
export function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
}
