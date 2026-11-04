/**
 * Initialize maybe_vault's config right after deployment (called by scripts/deploy-programs.sh).
 * Sets the fee cap and treasury owner with development attestors OFF, then disables them for good.
 * PREPARED FOR REVIEW — not run in this repository.
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { MaybeClient, LOCALNET_PROGRAM_IDS } from "@maybe/sdk";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`--${k} is required`);
  return v;
};

async function main() {
  const url = arg("url");
  if (/127\.0\.0\.1|localhost/.test(url)) throw new Error("use scripts/localnet-setup.ts for a local validator");
  const programId = new PublicKey(arg("program-id"));
  if (programId.equals(LOCALNET_PROGRAM_IDS.vault)) throw new Error("refusing the localnet program id");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(arg("admin"), "utf8")) as number[]));
  const treasuryOwner = new PublicKey(arg("treasury-owner"));
  const maxFee = Number(arg("max-fee-bps"));
  if (!(maxFee >= 0 && maxFee <= 100)) throw new Error("max fee must be 0–100 bps");
  const client = new MaybeClient(new Connection(url, "confirmed"), { vault: programId, venue: PublicKey.default });
  const init = await client.send([client.vaultIx.initConfig(admin.publicKey, maxFee, false, treasuryOwner)], [admin]);
  if (!init.ok) throw new Error(`init_config failed: ${init.error}`);
  const off = await client.send([client.vaultIx.disableDevAttestors(admin.publicKey)], [admin]);
  if (!off.ok) throw new Error(`disable_dev_attestors failed: ${off.error}`);
  console.log(`config initialized at ${client.pdas.config().toBase58()} (dev attestors disabled)`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
