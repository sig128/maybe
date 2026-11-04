import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  type AccountMeta,
  type Commitment,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { NodeOp, ActionKind, RouteKind, chunkPlan, decodePlan, hexToBytes, sha256Bytes, type Plan } from "@maybe/core";
import {
  decodeConfig,
  decodeOutcomeEvent,
  decodeOutcomeMarket,
  decodePolicy,
  decodePool,
  decodeStrategy,
  decodeVault,
  type ConfigAccount,
  type StrategyAccount,
  type VaultAccount,
} from "./accounts.ts";
import { VaultIx, VenueIx } from "./instructions.ts";
import { ata, LOCALNET_PROGRAM_IDS, type ProgramIds } from "./ids.ts";
import { errorCodeFrom, parseVaultEvents, vaultErrorName, type VaultEvent } from "./events.ts";

export interface TxResult {
  ok: boolean;
  signature?: string;
  logs: string[];
  events: VaultEvent[];
  code?: number;
  error?: string;
}

/**
 * Thin client over a Connection: sends transactions, decodes accounts and
 * assembles the account lists execute/activate/close need. Holds no user keys:
 * callers pass the signers for each transaction.
 */
export class MaybeClient {
  readonly vaultIx: VaultIx;
  readonly venueIx: VenueIx;
  constructor(
    public conn: Connection,
    public ids: ProgramIds = LOCALNET_PROGRAM_IDS,
    public commitment: Commitment = "confirmed",
  ) {
    this.vaultIx = new VaultIx(ids);
    this.venueIx = new VenueIx(ids);
  }

  get pdas() {
    return this.vaultIx.pdas;
  }

  async send(ixs: TransactionInstruction[], signers: Keypair[], opts: { computeUnits?: number; skipPreflight?: boolean } = {}): Promise<TxResult> {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits ?? 600_000 }));
    tx.add(...ixs);
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash(this.commitment);
    tx.recentBlockhash = blockhash;
    tx.feePayer = signers[0]!.publicKey;
    tx.sign(...signers);
    try {
      const signature = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: opts.skipPreflight ?? false, preflightCommitment: this.commitment });
      const conf = await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, this.commitment);
      const info = await this.conn.getTransaction(signature, { commitment: this.commitment === "processed" ? "confirmed" : (this.commitment as "confirmed"), maxSupportedTransactionVersion: 0 });
      const logs = info?.meta?.logMessages ?? [];
      if (conf.value.err || info?.meta?.err) {
        const code = errorCodeFrom(conf.value.err ?? info?.meta?.err, logs);
        return { ok: false, signature, logs, events: [], ...(code !== undefined ? { code, error: vaultErrorName(code) ?? `custom ${code}` } : { error: JSON.stringify(conf.value.err) }) };
      }
      return { ok: true, signature, logs, events: parseVaultEvents(logs, this.ids.vault) };
    } catch (e) {
      let logs: string[] = [];
      if (e instanceof SendTransactionError) {
        logs = (await e.getLogs(this.conn).catch(() => null)) ?? e.logs ?? [];
      }
      const code = errorCodeFrom((e as { transactionError?: unknown }).transactionError ?? String(e), logs);
      return { ok: false, logs, events: [], ...(code !== undefined ? { code, error: vaultErrorName(code) ?? `custom ${code}` } : { error: String((e as Error).message ?? e) }) };
    }
  }

  async account(k: PublicKey) {
    const a = await this.conn.getAccountInfo(k, this.commitment);
    if (!a) throw new Error(`account ${k.toBase58()} not found`);
    return a;
  }
  async config(): Promise<ConfigAccount> {
    return decodeConfig((await this.account(this.pdas.config())).data);
  }
  async vault(k: PublicKey): Promise<VaultAccount> {
    return decodeVault((await this.account(k)).data);
  }
  async strategy(k: PublicKey): Promise<StrategyAccount> {
    return decodeStrategy((await this.account(k)).data);
  }
  async event(k: PublicKey) {
    return decodeOutcomeEvent((await this.account(k)).data);
  }
  async policy(k: PublicKey) {
    return decodePolicy((await this.account(k)).data);
  }
  async tokenAmount(k: PublicKey): Promise<bigint> {
    const b = await this.conn.getTokenAccountBalance(k, this.commitment);
    return BigInt(b.value.amount);
  }

  /** Create (idempotently) and register the vault's ATA for a listed mint. */
  async registerMintIxs(payer: PublicKey, vault: PublicKey, mint: PublicKey, tokenProgram: PublicKey): Promise<{ tokenAccount: PublicKey; ixs: TransactionInstruction[] }> {
    const tokenAccount = ata(vault, mint, tokenProgram);
    return {
      tokenAccount,
      ixs: [createAssociatedTokenAccountIdempotentInstruction(payer, tokenAccount, vault, mint, tokenProgram), this.vaultIx.registerMint(vault, mint, tokenAccount)],
    };
  }

  /** create_strategy → write_plan chunks → activate_strategy. Returns the strategy address. */
  async uploadAndActivate(creator: Keypair, vault: PublicKey, strategyId: bigint, version: number, bytes: Uint8Array, policy?: PublicKey): Promise<{ strategy: PublicKey; results: TxResult[] }> {
    const hash = sha256Bytes(bytes);
    const { strategy, ix } = this.vaultIx.createStrategy(creator.publicKey, vault, strategyId, version, bytes.length, hash, policy);
    const results: TxResult[] = [await this.send([ix], [creator])];
    if (!results[0]!.ok) return { strategy, results };
    for (const c of chunkPlan(bytes, 800)) {
      const r = await this.send([this.vaultIx.writePlan(creator.publicKey, strategy, c.offset, c.data)], [creator]);
      results.push(r);
      if (!r.ok) return { strategy, results };
    }
    const plan = decodePlan(bytes);
    const remaining = [...plan.events, ...plan.refs].map((a) => new PublicKey(a));
    results.push(await this.send([this.vaultIx.activateStrategy(creator.publicKey, vault, strategy, remaining, policy)], [creator]));
    return { strategy, results };
  }

  static receiptRefs(plan: Plan): number[] {
    return [...new Set(plan.nodes.filter((n) => n.op === NodeOp.RECEIPT && n.a !== 0xff).map((n) => n.a))].sort((a, b) => a - b);
  }

  /** Events + receipt-referenced strategies (prefix of execute/close_completed remaining accounts). */
  contextAccounts(plan: Plan): AccountMeta[] {
    return [
      ...plan.events.map((e) => ({ pubkey: new PublicKey(e), isSigner: false, isWritable: false })),
      ...MaybeClient.receiptRefs(plan).map((r) => ({ pubkey: new PublicKey(plan.refs[r]!), isSigner: false, isWritable: false })),
    ];
  }

  /**
   * Remaining accounts for execute_action (docs/INTERFACE_CONTRACT.md §6).
   * `override` lets tests substitute accounts to prove the program rejects them.
   */
  async executeAccounts(plan: Plan, action: number, vault: VaultAccount, config: ConfigAccount, override?: (metas: AccountMeta[]) => AccountMeta[]): Promise<AccountMeta[]> {
    const a = plan.actions[action]!;
    const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
    const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
    const inMint = new PublicKey(plan.mints[a.inMint]!);
    const entry = (m: PublicKey) => {
      const e = vault.balances.find((b) => b.mint.equals(m));
      if (!e) throw new Error(`vault has no token account for ${m.toBase58()}`);
      return e.tokenAccount;
    };
    const asset = (m: PublicKey) => {
      const x = config.assets.find((y) => y.mint.equals(m));
      if (!x) throw new Error(`asset ${m.toBase58()} not listed`);
      return x;
    };
    let tail: AccountMeta[] = [];
    if (a.kind === ActionKind.SWAP) {
      const outMint = new PublicKey(plan.mints[a.outMint]!);
      const route = config.routes.find((x) => x.kind === a.routeKind);
      if (!route) throw new Error("route not configured");
      const ref = new PublicKey(plan.refs[a.ref]!);
      const treasury = asset(inMint).treasury;
      if (a.routeKind === RouteKind.CP_SWAP) {
        const pool = decodePool((await this.account(ref)).data);
        tail = [ro(route.programId), ro(ref), ro(pool.mintA), ro(pool.mintB), rw(pool.vaultA), rw(pool.vaultB), ro(pool.tokenProgramA), ro(pool.tokenProgramB), rw(entry(inMint)), rw(entry(outMint)), rw(treasury)];
      } else {
        const m = decodeOutcomeMarket((await this.account(ref)).data);
        const head = a.routeKind === RouteKind.OUTCOME_BUY ? [ro(route.programId), ro(ref)] : [ro(route.programId), ro(ref), ro(m.event)];
        tail = [...head, ro(m.collateralMint), rw(m.yesMint), rw(m.vault), ro(m.tokenProgram), rw(entry(inMint)), rw(entry(outMint)), rw(treasury)];
      }
    } else if (a.kind === ActionKind.TRANSFER) {
      const recipient = new PublicKey(plan.refs[a.ref]!);
      const as = asset(inMint);
      tail = [rw(entry(inMint)), ro(inMint), rw(ata(recipient, inMint, as.tokenProgram)), ro(as.tokenProgram), rw(as.treasury)];
    }
    const metas = [...this.contextAccounts(plan), ...tail];
    return override ? override(metas) : metas;
  }

  async execute(keeper: Keypair, vault: PublicKey, strategy: PublicKey, action: number, run: number, opts: { override?: (m: AccountMeta[]) => AccountMeta[]; planHash?: Uint8Array } = {}): Promise<TxResult> {
    const s = await this.strategy(strategy);
    const plan = decodePlan(s.plan);
    const metas = await this.executeAccounts(plan, action, await this.vault(vault), await this.config(), opts.override);
    return this.send([this.vaultIx.executeAction(keeper.publicKey, vault, strategy, action, run, opts.planHash ?? s.planHash, metas)], [keeper]);
  }

  async closeCompleted(payer: Keypair, vault: PublicKey, strategy: PublicKey): Promise<TxResult> {
    const s = await this.strategy(strategy);
    const plan = decodePlan(s.plan);
    return this.send([this.vaultIx.closeCompleted(vault, strategy, this.contextAccounts(plan).map((m) => m.pubkey))], [payer]);
  }
}

export { hexToBytes };
