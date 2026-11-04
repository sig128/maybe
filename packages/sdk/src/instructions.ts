import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { Writer, ixDisc } from "./codec.ts";
import { Pdas, SYSTEM_PROGRAM_ID, SYSVAR_INSTRUCTIONS_PUBKEY, type ProgramIds, LOCALNET_PROGRAM_IDS } from "./ids.ts";

/**
 * Instruction builders for maybe_vault and maybe_testvenue. Account order
 * follows each #[derive(Accounts)] struct; args are Borsh-encoded. The IDLs in
 * ./idl are the generated reference for both.
 */

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

export interface PolicyArgs {
  mints: PublicKey[];
  maxTotal: bigint[];
  maxPerAction: bigint[];
  routes: PublicKey[];
  recipients: PublicKey[];
  maxFeeBps: number;
  expiresAt: number;
  canCreate: boolean;
}

export class VaultIx {
  readonly pdas: Pdas;
  constructor(public ids: ProgramIds = LOCALNET_PROGRAM_IDS) {
    this.pdas = new Pdas(ids);
  }
  private ix(name: string, keys: AccountMeta[], data: Writer = new Writer(), remaining: AccountMeta[] = []): TransactionInstruction {
    return new TransactionInstruction({ programId: this.ids.vault, keys: [...keys, ...remaining], data: Buffer.concat([ixDisc(name), data.done()]) });
  }
  private optional(k?: PublicKey, writable = false): AccountMeta {
    return k ? (writable ? w(k) : r(k)) : r(this.ids.vault);
  }

  initConfig(admin: PublicKey, maxFeeBpsCap: number, allowDevAttestors: boolean, treasuryOwner: PublicKey) {
    return this.ix("init_config", [w(admin, true), w(this.pdas.config()), r(SYSTEM_PROGRAM_ID)], new Writer().u16(maxFeeBpsCap).bool(allowDevAttestors).pubkey(treasuryOwner));
  }
  setAsset(admin: PublicKey, mint: PublicKey, treasury: PublicKey, enabled: boolean) {
    return this.ix("set_asset", [r(admin, true), w(this.pdas.config()), r(mint), r(treasury)], new Writer().bool(enabled));
  }
  setRoute(admin: PublicKey, kind: number, programId: PublicKey, enabled: boolean) {
    return this.ix("set_route", [r(admin, true), w(this.pdas.config())], new Writer().u8(kind).pubkey(programId).bool(enabled));
  }
  disableDevAttestors(admin: PublicKey) {
    return this.ix("disable_dev_attestors", [r(admin, true), w(this.pdas.config())]);
  }
  setPaused(admin: PublicKey, paused: boolean) {
    return this.ix("set_paused", [r(admin, true), w(this.pdas.config())], new Writer().bool(paused));
  }
  initAttestorSet(admin: PublicKey, setId: bigint, keys: PublicKey[], threshold: number, adjudicationThreshold: number, challengeSeconds: number, disputeTimeoutSeconds: number, isDev: boolean) {
    return this.ix(
      "init_attestor_set",
      [w(admin, true), r(this.pdas.config()), w(this.pdas.attestorSet(setId)), r(SYSTEM_PROGRAM_ID)],
      new Writer().u64(setId).vec(keys, (x, k) => x.pubkey(k)).u8(threshold).u8(adjudicationThreshold).u32(challengeSeconds).u32(disputeTimeoutSeconds).bool(isDev),
    );
  }
  revokeAttestor(admin: PublicKey, attestorSet: PublicKey, index: number) {
    return this.ix("revoke_attestor", [r(admin, true), r(this.pdas.config()), w(attestorSet)], new Writer().u8(index));
  }
  createEvent(payer: PublicKey, o: { adapter: number; venue: number; marketIdHash: Uint8Array; ruleHash: Uint8Array; threshold: bigint; deadline: number; binding: PublicKey }) {
    const event = this.pdas.event(o.adapter, o.marketIdHash, o.ruleHash, o.binding);
    return {
      event,
      ix: this.ix(
        "create_event",
        [w(payer, true), w(event), r(o.binding), r(SYSTEM_PROGRAM_ID)],
        new Writer().u8(o.adapter).u8(o.venue).fixed(o.marketIdHash).fixed(o.ruleHash).u64(o.threshold).i64(o.deadline),
      ),
    };
  }
  attest(event: PublicKey, attestorSet: PublicKey, outcome: number, observedAt: number, nonce: bigint, expiresAt: number) {
    return this.ix("attest", [w(event), r(attestorSet), r(this.pdas.config()), r(SYSVAR_INSTRUCTIONS_PUBKEY)], new Writer().u8(outcome).i64(observedAt).u64(nonce).i64(expiresAt));
  }
  adjudicate(event: PublicKey, attestorSet: PublicKey, outcome: number, nonce: bigint, expiresAt: number) {
    return this.ix("adjudicate", [w(event), r(attestorSet), r(this.pdas.config()), r(SYSVAR_INSTRUCTIONS_PUBKEY)], new Writer().u8(outcome).u64(nonce).i64(expiresAt));
  }
  voidDisputed(event: PublicKey, attestorSet: PublicKey) {
    return this.ix("void_disputed", [w(event), r(attestorSet)]);
  }
  finalizeEvent(event: PublicKey) {
    return this.ix("finalize_event", [w(event)]);
  }
  observeBalance(event: PublicKey, watched: PublicKey) {
    return this.ix("observe_balance", [w(event), r(watched)]);
  }
  initVault(owner: PublicKey, vaultId: bigint) {
    return this.ix("init_vault", [w(owner, true), w(this.pdas.vault(owner, vaultId)), r(SYSTEM_PROGRAM_ID)], new Writer().u64(vaultId));
  }
  registerMint(vault: PublicKey, mint: PublicKey, vaultTokenAccount: PublicKey) {
    return this.ix("register_mint", [r(this.pdas.config()), w(vault), r(mint), r(vaultTokenAccount)]);
  }
  deposit(owner: PublicKey, vault: PublicKey, mint: PublicKey, source: PublicKey, vaultTokenAccount: PublicKey, tokenProgram: PublicKey, amount: bigint) {
    return this.ix("deposit", [r(owner, true), r(this.pdas.config()), w(vault), r(mint), w(source), w(vaultTokenAccount), r(tokenProgram)], new Writer().u64(amount));
  }
  withdraw(owner: PublicKey, vault: PublicKey, mint: PublicKey, vaultTokenAccount: PublicKey, destination: PublicKey, tokenProgram: PublicKey, amount: bigint) {
    return this.ix("withdraw", [r(owner, true), r(this.pdas.config()), w(vault), r(mint), w(vaultTokenAccount), w(destination), r(tokenProgram)], new Writer().u64(amount));
  }
  createStrategy(creator: PublicKey, vault: PublicKey, strategyId: bigint, version: number, planLen: number, planHash: Uint8Array, policy?: PublicKey) {
    const strategy = this.pdas.strategy(vault, strategyId);
    return {
      strategy,
      ix: this.ix(
        "create_strategy",
        [w(creator, true), w(vault), w(strategy), this.optional(policy), r(SYSTEM_PROGRAM_ID)],
        new Writer().u64(strategyId).u32(version).u16(planLen).fixed(planHash),
      ),
    };
  }
  writePlan(creator: PublicKey, strategy: PublicKey, offset: number, data: Uint8Array) {
    return this.ix("write_plan", [r(creator, true), w(strategy)], new Writer().u16(offset).bytes(data));
  }
  /** remaining: every plan event (in order) then every plan ref (in order) */
  activateStrategy(creator: PublicKey, vault: PublicKey, strategy: PublicKey, remaining: PublicKey[], policy?: PublicKey) {
    return this.ix("activate_strategy", [r(creator, true), r(this.pdas.config()), w(vault), w(strategy), this.optional(policy, true)], new Writer(), remaining.map((k) => r(k)));
  }
  executeAction(keeper: PublicKey, vault: PublicKey, strategy: PublicKey, action: number, run: number, planHash: Uint8Array, remaining: AccountMeta[]) {
    return this.ix("execute_action", [r(keeper, true), r(this.pdas.config()), w(vault), w(strategy)], new Writer().u8(action).u16(run).fixed(planHash), remaining);
  }
  pauseStrategy(owner: PublicKey, vault: PublicKey, strategy: PublicKey, paused: boolean) {
    return this.ix("pause_strategy", [r(owner, true), w(vault), w(strategy)], new Writer().bool(paused));
  }
  cancelStrategy(owner: PublicKey, vault: PublicKey, strategy: PublicKey) {
    return this.ix("cancel_strategy", [r(owner, true), w(vault), w(strategy)]);
  }
  closeExpired(vault: PublicKey, strategy: PublicKey) {
    return this.ix("close_expired", [w(vault), w(strategy)]);
  }
  closeCompleted(vault: PublicKey, strategy: PublicKey, remaining: PublicKey[]) {
    return this.ix("close_completed", [w(vault), w(strategy)], new Writer(), remaining.map((k) => r(k)));
  }
  createPolicy(owner: PublicKey, vault: PublicKey, sessionKey: PublicKey, a: PolicyArgs) {
    const policy = this.pdas.policy(vault, sessionKey);
    const data = new Writer()
      .vec(a.mints, (x, k) => x.pubkey(k))
      .vec(a.maxTotal, (x, v) => x.u64(v))
      .vec(a.maxPerAction, (x, v) => x.u64(v))
      .vec(a.routes, (x, k) => x.pubkey(k))
      .vec(a.recipients, (x, k) => x.pubkey(k))
      .u16(a.maxFeeBps)
      .i64(a.expiresAt)
      .bool(a.canCreate);
    return { policy, ix: this.ix("create_policy", [w(owner, true), r(vault), r(sessionKey), w(policy), r(SYSTEM_PROGRAM_ID)], data) };
  }
  revokePolicy(owner: PublicKey, policy: PublicKey) {
    return this.ix("revoke_policy", [r(owner, true), w(policy)]);
  }
  killSwitch(owner: PublicKey, vault: PublicKey) {
    return this.ix("kill_switch", [r(owner, true), w(vault)]);
  }
}

export class VenueIx {
  readonly pdas: Pdas;
  constructor(public ids: ProgramIds = LOCALNET_PROGRAM_IDS) {
    this.pdas = new Pdas(ids);
  }
  private ix(name: string, keys: AccountMeta[], data: Writer = new Writer(), remaining: AccountMeta[] = []) {
    return new TransactionInstruction({ programId: this.ids.venue, keys: [...keys, ...remaining], data: Buffer.concat([ixDisc(name), data.done()]) });
  }
  initPool(admin: PublicKey, poolId: bigint, feeBps: number, mode: number, mintA: PublicKey, mintB: PublicKey, vaultA: PublicKey, vaultB: PublicKey, tpA: PublicKey, tpB: PublicKey) {
    const pool = this.pdas.pool(poolId);
    return { pool, ix: this.ix("init_pool", [w(admin, true), w(pool), r(mintA), r(mintB), r(vaultA), r(vaultB), r(tpA), r(tpB), r(SYSTEM_PROGRAM_ID)], new Writer().u64(poolId).u16(feeBps).u8(mode)) };
  }
  addLiquidity(provider: PublicKey, pool: PublicKey, mintA: PublicKey, mintB: PublicKey, vaultA: PublicKey, vaultB: PublicKey, srcA: PublicKey, srcB: PublicKey, tpA: PublicKey, tpB: PublicKey, amountA: bigint, amountB: bigint) {
    return this.ix("add_liquidity", [r(provider, true), r(pool), r(mintA), r(mintB), w(vaultA), w(vaultB), w(srcA), w(srcB), r(tpA), r(tpB)], new Writer().u64(amountA).u64(amountB));
  }
  swap(pool: PublicKey, mintA: PublicKey, mintB: PublicKey, vaultA: PublicKey, vaultB: PublicKey, userSrc: PublicKey, userDst: PublicKey, user: PublicKey, tpA: PublicKey, tpB: PublicKey, amountIn: bigint, minOut: bigint) {
    return this.ix("swap", [r(pool), r(mintA), r(mintB), w(vaultA), w(vaultB), w(userSrc), w(userDst), r(user, true), r(tpA), r(tpB)], new Writer().u64(amountIn).u64(minOut));
  }
  initOutcomeMarket(admin: PublicKey, event: PublicKey, collateralMint: PublicKey, yesMint: PublicKey, vault: PublicKey, tp: PublicKey, yesPriceE6: bigint) {
    const market = this.pdas.outcomeMarket(event);
    return { market, ix: this.ix("init_outcome_market", [w(admin, true), w(market), r(event), r(collateralMint), r(yesMint), r(vault), r(tp), r(SYSTEM_PROGRAM_ID)], new Writer().u64(yesPriceE6)) };
  }
  fundMarket(funder: PublicKey, market: PublicKey, collateralMint: PublicKey, vault: PublicKey, src: PublicKey, tp: PublicKey, amount: bigint) {
    return this.ix("fund_market", [r(funder, true), r(market), r(collateralMint), w(vault), w(src), r(tp)], new Writer().u64(amount));
  }
}
