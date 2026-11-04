/**
 * LOCALNET ONLY. Seeds a fresh solana-test-validator with everything the
 * fixtures describe — config, listed assets (real test mints), routes, the dev
 * attestor set, outcome events, pools at fixture prices, malicious test pools
 * and the Orbit outcome market — and writes .localnet/localnet.json.
 *
 *   scripts/validator.sh && npx tsx scripts/localnet-setup.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMint,
  getMintLen,
  mintTo,
  tokenMetadataInitializeWithRentTransfer,
} from "@solana/spl-token";
import { ASSET_FIXTURES, MARKET_FIXTURES, POOL_FIXTURES, buildFixtures, hexToBytes, ruleHashFor, sha256Bytes } from "@maybe/core";
import { ADAPTER_ATTESTATION, ADAPTER_BALANCE, LOCALNET_PROGRAM_IDS, MaybeClient, POOL_MODE, ROUTE_KIND, VENUE_CODE, ata, attestationMessage, ed25519Instructions, localnetKeypair, repoRoot, type LocalnetBook, type LocalnetPool } from "../src/index.ts";

const RPC = process.env.MAYBE_RPC ?? "http://127.0.0.1:8899";
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error(`localnet-setup refuses non-local RPC ${RPC}`);

const conn = new Connection(RPC, "confirmed");
const client = new MaybeClient(conn);
const admin = localnetKeypair("admin");
const keeper = localnetKeypair("keeper");
const attestors = [1, 2, 3].map((i) => localnetKeypair(`dev_attestor_${i}`));
const now = Math.floor(Date.now() / 1000);
const fx = buildFixtures(now); // sim addresses: only used for address-independent values (reserves, prices)
const log = (...a: unknown[]) => console.log("[setup]", ...a);

async function airdrop(k: PublicKey, sol: number) {
  const sig = await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL);
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

async function must(label: string, p: ReturnType<MaybeClient["send"]>) {
  const r = await p;
  if (!r.ok) throw new Error(`${label} failed: ${r.error}\n${r.logs.slice(-8).join("\n")}`);
  return r;
}

async function token2022Mint(decimals: number, opts: { metadata?: { name: string; symbol: string }; transferFeeBps?: number }): Promise<PublicKey> {
  const mint = Keypair.generate();
  const exts: ExtensionType[] = [];
  if (opts.metadata) exts.push(ExtensionType.MetadataPointer);
  if (opts.transferFeeBps !== undefined) exts.push(ExtensionType.TransferFeeConfig);
  const len = getMintLen(exts);
  const lamports = await conn.getMinimumBalanceForRentExemption(len + (opts.metadata ? 400 : 0));
  const tx = new Transaction().add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports, programId: TOKEN_2022_PROGRAM_ID }));
  if (opts.metadata) tx.add(createInitializeMetadataPointerInstruction(mint.publicKey, admin.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID));
  if (opts.transferFeeBps !== undefined) tx.add(createInitializeTransferFeeConfigInstruction(mint.publicKey, admin.publicKey, admin.publicKey, opts.transferFeeBps, 1_000_000_000n, TOKEN_2022_PROGRAM_ID));
  tx.add(createInitializeMintInstruction(mint.publicKey, decimals, admin.publicKey, null, TOKEN_2022_PROGRAM_ID));
  await sendAndConfirmTransaction(conn, tx, [admin, mint], { commitment: "confirmed" });
  if (opts.metadata) {
    await tokenMetadataInitializeWithRentTransfer(conn, admin, mint.publicKey, admin.publicKey, admin, opts.metadata.name, opts.metadata.symbol, "https://example.invalid/maybe-local.json", [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
  }
  return mint.publicKey;
}

async function main() {
  log("rpc", RPC);
  await airdrop(admin.publicKey, 500);
  await airdrop(keeper.publicKey, 100);
  await must("init_config", client.send([client.vaultIx.initConfig(admin.publicKey, 100, true, admin.publicKey)], [admin]));

  // ---- assets: real local test mints
  const assets: LocalnetBook["assets"] = {};
  const orbitKey = "orbit-launch";
  const mintKeys = new Map<string, PublicKey>();
  for (const a of ASSET_FIXTURES) {
    if (a.key === "YES-ORBIT") continue; // created with the outcome market (authority = market PDA)
    let mint: PublicKey;
    let tokenProgram = TOKEN_PROGRAM_ID;
    if (a.key === "MAYBE") {
      mint = await token2022Mint(a.decimals, { metadata: { name: "MAYBE (local)", symbol: "MAYBE" } });
      tokenProgram = TOKEN_2022_PROGRAM_ID;
    } else if (a.key === "TAXED") {
      mint = await token2022Mint(a.decimals, { transferFeeBps: 100 });
      tokenProgram = TOKEN_2022_PROGRAM_ID;
    } else {
      mint = await createMint(conn, admin, admin.publicKey, a.freezeAuthority ? admin.publicKey : null, a.decimals, Keypair.generate(), { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    }
    mintKeys.set(a.key, mint);
    const treasury = await createAssociatedTokenAccountIdempotent(conn, admin, mint, admin.publicKey, { commitment: "confirmed" }, tokenProgram);
    const r = await client.send([client.vaultIx.setAsset(admin.publicKey, mint, treasury, true)], [admin]);
    assets[a.key] = { mint: mint.toBase58(), tokenProgram: tokenProgram.toBase58(), decimals: a.decimals, treasury: treasury.toBase58(), listed: r.ok };
    log(`asset ${a.key.padEnd(6)} ${mint.toBase58()} ${r.ok ? "listed" : `REJECTED (${r.error})`}`);
    if (a.key === "TAXED" && r.ok) throw new Error("transfer-fee mint must be rejected");
    if (a.key !== "TAXED" && !r.ok) throw new Error(`could not list ${a.key}: ${r.error}`);
  }

  // ---- routes (all served by the local test venue)
  for (const kind of [ROUTE_KIND.CP_SWAP, ROUTE_KIND.OUTCOME_BUY, ROUTE_KIND.OUTCOME_REDEEM]) {
    await must(`set_route ${kind}`, client.send([client.vaultIx.setRoute(admin.publicKey, kind, LOCALNET_PROGRAM_IDS.venue, true)], [admin]));
  }

  // ---- dev attestor set: 2 of 3, 5 s challenge window, adjudication needs all 3
  const setId = 1n;
  const challengeSeconds = 5;
  await must("init_attestor_set", client.send([client.vaultIx.initAttestorSet(admin.publicKey, setId, attestors.map((k) => k.publicKey), 2, 3, challengeSeconds, 60, true)], [admin]));
  const attestorSet = client.pdas.attestorSet(setId);

  // ---- outcome events
  const events: LocalnetBook["events"] = {};
  const watched: LocalnetBook["watched"] = {};
  const usdc = mintKeys.get("USDC")!;
  for (const m of MARKET_FIXTURES) {
    if (m.kind !== "binary") continue;
    const marketIdHash = sha256Bytes(`${m.venue}:${m.venueMarketId}`);
    const ruleHash = hexToBytes(ruleHashFor(m));
    let binding = attestorSet;
    let adapter = ADAPTER_ATTESTATION;
    let threshold = 0n;
    let deadline = 0;
    if (m.adapter === "balance-threshold" && m.balance) {
      const escrowOwner = Keypair.generate();
      const acct = await createAssociatedTokenAccountIdempotent(conn, admin, usdc, escrowOwner.publicKey, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
      watched[m.balance.watched] = { address: acct.toBase58(), mint: usdc.toBase58(), owner: escrowOwner.publicKey.toBase58() };
      binding = acct;
      adapter = ADAPTER_BALANCE;
      threshold = m.balance.thresholdUnits;
      deadline = now + m.closesInDays * 86_400;
    }
    const { event, ix } = client.vaultIx.createEvent(admin.publicKey, { adapter, venue: VENUE_CODE[m.venue] ?? 0, marketIdHash, ruleHash, threshold, deadline, binding });
    await must(`create_event ${m.key}`, client.send([ix], [admin]));
    events[m.key] = { address: event.toBase58(), adapter, venueMarketId: m.venueMarketId, marketIdHash: Buffer.from(marketIdHash).toString("hex"), ruleHash: ruleHashFor(m), binding: binding.toBase58(), deadline };
    if (m.status === "voided") {
      // reflect the fixture: attest VOID with 2 of 3 dev attestors
      const fields = { programId: LOCALNET_PROGRAM_IDS.vault, event, ruleHash, outcome: 2, observedAt: now, nonce: 1n, expiresAt: now + 600 };
      const msg = attestationMessage(fields);
      await must(`attest void ${m.key}`, client.send([...ed25519Instructions(msg, attestors.slice(0, 2).map((k) => k.secretKey)), client.vaultIx.attest(event, attestorSet, 2, now, 1n, now + 600)], [admin]));
    }
  }
  log(`events: ${Object.keys(events).length}`);

  // ---- pools at fixture prices
  let poolId = 1n;
  const pools: Record<string, LocalnetPool> = {};
  const maliciousPools: Record<string, LocalnetPool> = {};
  const tp = (k: string) => new PublicKey(assets[k]!.tokenProgram);
  async function makePool(keyA: string, keyB: string, reserveA: bigint, reserveB: bigint, mode: number): Promise<LocalnetPool> {
    const id = poolId++;
    const mintA = mintKeys.get(keyA)!;
    const mintB = mintKeys.get(keyB)!;
    const pool = client.pdas.pool(id);
    const vaultA = await createAssociatedTokenAccountIdempotent(conn, admin, mintA, pool, { commitment: "confirmed" }, tp(keyA), undefined, true);
    const vaultB = await createAssociatedTokenAccountIdempotent(conn, admin, mintB, pool, { commitment: "confirmed" }, tp(keyB), undefined, true);
    const ix = client.venueIx.initPool(admin.publicKey, id, 30, mode, mintA, mintB, vaultA, vaultB, tp(keyA), tp(keyB));
    await must(`init_pool ${keyA}-${keyB}`, client.send([ix.ix], [admin]));
    const srcA = await createAssociatedTokenAccountIdempotent(conn, admin, mintA, admin.publicKey, { commitment: "confirmed" }, tp(keyA));
    const srcB = await createAssociatedTokenAccountIdempotent(conn, admin, mintB, admin.publicKey, { commitment: "confirmed" }, tp(keyB));
    await mintTo(conn, admin, mintA, srcA, admin, reserveA, [], { commitment: "confirmed" }, tp(keyA));
    await mintTo(conn, admin, mintB, srcB, admin, reserveB, [], { commitment: "confirmed" }, tp(keyB));
    await must("add_liquidity", client.send([client.venueIx.addLiquidity(admin.publicKey, pool, mintA, mintB, vaultA, vaultB, srcA, srcB, tp(keyA), tp(keyB), reserveA, reserveB)], [admin]));
    return { address: pool.toBase58(), poolId: id.toString(), mode, mintA: mintA.toBase58(), mintB: mintB.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58() };
  }
  for (const p of POOL_FIXTURES) {
    const sim = fx.poolByKey[p.key]!;
    pools[p.key] = await makePool(p.a, p.b, sim.reserveA, sim.reserveB, POOL_MODE.HONEST);
  }
  const lumenPool = fx.poolByKey["USDC-LUMEN"]!;
  for (const [name, mode] of Object.entries(POOL_MODE)) {
    if (mode === POOL_MODE.HONEST) continue;
    maliciousPools[name.toLowerCase()] = await makePool("USDC", "LUMEN", lumenPool.reserveA / 40n, lumenPool.reserveB / 40n, mode);
  }
  log(`pools: ${Object.keys(pools).length} honest, ${Object.keys(maliciousPools).length} malicious`);

  // ---- Orbit outcome market (YES token mint authority = market PDA)
  const orbitEvent = new PublicKey(events[orbitKey]!.address);
  const market = client.pdas.outcomeMarket(orbitEvent);
  const yesMint = await createMint(conn, admin, market, null, 6, Keypair.generate(), { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
  const yesTreasury = await createAssociatedTokenAccountIdempotent(conn, admin, yesMint, admin.publicKey, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
  await must("set_asset YES", client.send([client.vaultIx.setAsset(admin.publicKey, yesMint, yesTreasury, true)], [admin]));
  assets["YES-ORBIT"] = { mint: yesMint.toBase58(), tokenProgram: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, treasury: yesTreasury.toBase58(), listed: true };
  const marketVault = await createAssociatedTokenAccountIdempotent(conn, admin, usdc, market, { commitment: "confirmed" }, TOKEN_PROGRAM_ID, undefined, true);
  const om = client.venueIx.initOutcomeMarket(admin.publicKey, orbitEvent, usdc, yesMint, marketVault, TOKEN_PROGRAM_ID, 610_000n);
  await must("init_outcome_market", client.send([om.ix], [admin]));
  const adminUsdc = ata(admin.publicKey, usdc, TOKEN_PROGRAM_ID);
  await mintTo(conn, admin, usdc, adminUsdc, admin, 100_000_000_000n, [], { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
  await must("fund_market", client.send([client.venueIx.fundMarket(admin.publicKey, market, usdc, marketVault, adminUsdc, TOKEN_PROGRAM_ID, 100_000_000_000n)], [admin]));

  const book: LocalnetBook = {
    cluster: "localnet",
    rpc: RPC,
    createdAt: now,
    programIds: { vault: LOCALNET_PROGRAM_IDS.vault.toBase58(), venue: LOCALNET_PROGRAM_IDS.venue.toBase58() },
    admin: admin.publicKey.toBase58(),
    keeper: keeper.publicKey.toBase58(),
    treasuryOwner: admin.publicKey.toBase58(),
    config: client.pdas.config().toBase58(),
    attestorSet: { address: attestorSet.toBase58(), setId: setId.toString(), keys: attestors.map((k) => k.publicKey.toBase58()), threshold: 2, challengeSeconds },
    assets,
    events,
    pools,
    maliciousPools,
    outcomeMarkets: { [orbitKey]: { address: market.toBase58(), collateralMint: usdc.toBase58(), yesMint: yesMint.toBase58(), vault: marketVault.toBase58(), event: orbitEvent.toBase58() } },
    watched,
  };
  const dir = join(repoRoot(), ".localnet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "localnet.json"), JSON.stringify(book, null, 2));
  log(`wrote ${join(dir, "localnet.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
