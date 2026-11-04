import { Ed25519Program, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * Attestation messages (domain separated, docs/INTERFACE_CONTRACT.md §6) and
 * Ed25519 precompile instructions. Only DEVELOPMENT attestor keys are ever held
 * by MAYBE code (localnet); production attestors sign out of band.
 */

export const ATTEST_DOMAIN = Buffer.from("MAYBE_ATTEST_V1");
export const ADJUDICATE_DOMAIN = Buffer.from("MAYBE_ADJUDICATE_V1");

export interface AttestationFields {
  programId: PublicKey;
  event: PublicKey;
  ruleHash: Uint8Array;
  /** 0 NO, 1 YES, 2 VOID */
  outcome: number;
  observedAt: number;
  nonce: bigint;
  expiresAt: number;
}

export function attestationMessage(f: AttestationFields, domain: Buffer = ATTEST_DOMAIN): Buffer {
  const tail = Buffer.alloc(1 + 8 + 8 + 8);
  tail.writeUInt8(f.outcome, 0);
  tail.writeBigInt64LE(BigInt(f.observedAt), 1);
  tail.writeBigUInt64LE(f.nonce, 9);
  tail.writeBigInt64LE(BigInt(f.expiresAt), 17);
  return Buffer.concat([domain, f.programId.toBuffer(), f.event.toBuffer(), Buffer.from(f.ruleHash), tail]);
}

/** One Ed25519 precompile instruction per signer (offsets point at the instruction itself). */
export function ed25519Instructions(message: Uint8Array, secretKeys: Uint8Array[]): TransactionInstruction[] {
  return secretKeys.map((sk) => {
    const seed = sk.slice(0, 32);
    const publicKey = ed25519.getPublicKey(seed);
    const signature = ed25519.sign(message, seed);
    return Ed25519Program.createInstructionWithPublicKey({ publicKey, message, signature });
  });
}
