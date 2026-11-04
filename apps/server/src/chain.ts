import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  Message,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SendTransactionError,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import bs58 from "bs58";
import { chunkPlan, decodePlan, sha256Bytes } from "@maybe/core";
import {
  MaybeClient,
  accountDisc,
  ata,
  attestationMessage,
  decodeConfig,
  decodeOutcomeEvent,
  decodePolicy,
  decodePool,
  decodeStrategy,
  decodeVault,
  ed25519Instructions,
  errorCodeFrom,
  localnetKeypair,
  parseVaultEvents,
  vaultErrorName,
  type ConfigAccount,
  type LocalnetBook,
  type OutcomeEventAccount,
  type PolicyAccount,
  type PolicyArgs,
  type ProgramIds,
  type StrategyAccount,
  type VaultAccount,
  type VaultEvent,
} from "@maybe/sdk";
import type { Config } from "./config.ts";

/**
 * Everything the server does with Solana. It builds unsigned transactions for
 * the user's wallet (fee payer = the user), submits what the wallet signed,
 * and reads accounts for the indexer. It never holds user keys. On localnet it
 * also holds the clearly labelled development keys (keeper, admin, dev
 * attestors) that the setup script created.
 */

export interface TxPlan {
  label: string;
  effect?: string;
  ixs: TransactionInstruction[];
  computeUnits?: number;
}

export interface CompiledTx {
  label: string;
  effect?: string;
  message: Buffer;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface SendOutcome {
  ok: boolean;
  signature?: string;
  slot?: number;
  logs: string[];
  events: VaultEvent[];
  error?: string;
  code?: number;
  /** blockhash expired before landing: nothing happened, safe to rebuild */
  expired?: boolean;
}

export class ChainError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

const tokenAmountAt = (data: Uint8Array): bigint => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);

/** Human-readable program errors for the screens that show them. */
const ERROR_TEXT: Record<string, string> = {
  InsufficientAvailable: "Not enough available in your vault. Reserved funds can't be used twice.",
  PlanHashMismatch: "The uploaded plan doesn't match what was signed.",
  PolicyViolation: "Outside the agent policy's limits.",
  PolicyRevoked: "The agent policy is revoked, expired or predates the kill switch.",
  NotOwner: "Only the vault owner can do this.",
  StrategyClosed: "This future is already closed.",
  ActionComplete: "That step already ran.",
  BranchLost: "Another branch of this group already executed.",
  ExecutionPaused: "Execution is paused for everyone (emergency pause).",
  MinOutNotMet: "The route returned less than the plan's minimum.",
  CancelLocked: "This plan locks cancellation until it expires.",
  AssetNotListed: "This asset isn't listed.",
};

export function explainError(name: string | undefined, fallback: string): string {
  return (name && ERROR_TEXT[name]) ?? (name ? `Program error: ${name}` : fallback);
}

export class Chain {
  readonly conn: Connection;
  readonly client: MaybeClient;
  readonly ids: ProgramIds;
  readonly keeper: Keypair;
  private readonly admin: Keypair | null;
  private readonly attestors: Keypair[];
  private clockCache = { at: 0, value: 0 };

  constructor(
    readonly book: LocalnetBook,
    readonly cfg: Config,
  ) {
    this.conn = new Connection(cfg.RPC_URL, "confirmed");
    this.ids = { vault: new PublicKey(book.programIds.vault), venue: new PublicKey(book.programIds.venue) };
    this.client = new MaybeClient(this.conn, this.ids);
    const local = cfg.MAYBE_MODE === "localnet";
    // localnet development keys only; other modes must provide a keeper key out of band
    this.keeper = local ? localnetKeypair("keeper") : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(cfg.KEEPER_KEYPAIR ?? "[]") as number[]));
    this.admin = local ? localnetKeypair("admin") : null;
    this.attestors = local && cfg.ALLOW_DEV_ATTESTORS === "true" ? [1, 2, 3].map((i) => localnetKeypair(`dev_attestor_${i}`)) : [];
  }

  get local(): boolean {
    return this.cfg.MAYBE_MODE === "localnet";
  }

  asset(mint: string) {
    const e = Object.entries(this.book.assets).find(([, a]) => a.mint === mint);
    if (!e) throw new ChainError("This asset isn't available here.");
    return { key: e[0], ...e[1], mintKey: new PublicKey(mint), program: new PublicKey(e[1].tokenProgram) };
  }

  vaultOf(owner: PublicKey): PublicKey {
    return this.client.pdas.vault(owner, 0n);
  }

  // ───────────────────────────────────────── reads

  /** Validator unix time (Clock sysvar), cached for a second. */
  async clock(): Promise<number> {
    if (Date.now() - this.clockCache.at < 1000) return this.clockCache.value;
    const a = await this.conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
    if (!a) throw new ChainError("Clock sysvar unavailable");
    const v = Number(new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigInt64(32, true));
    this.clockCache = { at: Date.now(), value: v };
    return v;
  }

  async health(): Promise<{ ok: boolean; slot?: number; detail: string }> {
    try {
      const slot = await this.conn.getSlot("confirmed");
      return { ok: true, slot, detail: `slot ${slot}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async config(): Promise<ConfigAccount> {
    return this.client.config();
  }

  async maybeVault(vault: PublicKey): Promise<VaultAccount | null> {
    const a = await this.conn.getAccountInfo(vault, "confirmed");
    return a ? decodeVault(a.data) : null;
  }

  async maybeStrategy(k: PublicKey): Promise<StrategyAccount | null> {
    const a = await this.conn.getAccountInfo(k, "confirmed");
    return a ? decodeStrategy(a.data) : null;
  }

  async maybePolicy(k: PublicKey): Promise<PolicyAccount | null> {
    const a = await this.conn.getAccountInfo(k, "confirmed");
    return a ? decodePolicy(a.data) : null;
  }

  async events(addresses: string[]): Promise<Map<string, OutcomeEventAccount>> {
    const out = new Map<string, OutcomeEventAccount>();
    for (let i = 0; i < addresses.length; i += 100) {
      const keys = addresses.slice(i, i + 100);
      const infos = await this.conn.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)), "confirmed");
      infos.forEach((a, j) => {
        if (a) out.set(keys[j]!, decodeOutcomeEvent(a.data));
      });
    }
    return out;
  }

  /** Every strategy account of a vault (discovery, independent of our own records). */
  async strategiesOf(vault: PublicKey): Promise<Array<{ address: PublicKey; account: StrategyAccount }>> {
    const r = await this.conn.getProgramAccounts(this.ids.vault, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(accountDisc("Strategy")) } }, { memcmp: { offset: 8, bytes: vault.toBase58() } }],
    });
    return r.map((x) => ({ address: x.pubkey, account: decodeStrategy(x.account.data) }));
  }

  /** Actual token-account balances (for reconciliation, never trusted from our ledger). */
  async tokenBalances(accounts: PublicKey[]): Promise<bigint[]> {
    const infos = await this.conn.getMultipleAccountsInfo(accounts, "confirmed");
    return infos.map((a) => (a && a.data.length >= 72 ? tokenAmountAt(a.data) : 0n));
  }

  /** The wallet's balances of every listed asset, in base units. */
  async walletBalances(owner: PublicKey): Promise<Record<string, bigint>> {
    const assets = Object.values(this.book.assets).filter((a) => a.listed);
    const atas = assets.map((a) => ata(owner, new PublicKey(a.mint), new PublicKey(a.tokenProgram)));
    const amounts = await this.tokenBalances(atas);
    const out: Record<string, bigint> = {};
    assets.forEach((a, i) => (out[a.mint] = amounts[i]!));
    return out;
  }

  async lamports(k: PublicKey): Promise<number> {
    return this.conn.getBalance(k, "confirmed");
  }

  /** Pool reserves for price estimates (read from the pool's token accounts). */
  async poolReserves(): Promise<Record<string, { mintA: string; mintB: string; reserveA: bigint; reserveB: bigint }>> {
    const pools = Object.values(this.book.pools);
    const amounts = await this.tokenBalances(pools.flatMap((p) => [new PublicKey(p.vaultA), new PublicKey(p.vaultB)]));
    const out: Record<string, { mintA: string; mintB: string; reserveA: bigint; reserveB: bigint }> = {};
    pools.forEach((p, i) => (out[p.address] = { mintA: p.mintA, mintB: p.mintB, reserveA: amounts[2 * i]!, reserveB: amounts[2 * i + 1]! }));
    return out;
  }

  async poolFeeBps(address: string): Promise<number> {
    return decodePool((await this.client.account(new PublicKey(address))).data).feeBps;
  }

  /** Vault-program events in the confirmed transactions that touched `address` (newest first, up to `limit`). */
  async eventsFor(address: PublicKey, o: { until?: string; limit?: number } = {}): Promise<Array<{ signature: string; slot: number; blockTime: number | null; events: VaultEvent[]; ok: boolean }>> {
    const sigs = await this.conn.getSignaturesForAddress(address, { limit: o.limit ?? 100, ...(o.until ? { until: o.until } : {}) }, "confirmed");
    const out: Array<{ signature: string; slot: number; blockTime: number | null; events: VaultEvent[]; ok: boolean }> = [];
    for (const s of sigs) {
      if (s.err) {
        out.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, events: [], ok: false });
        continue;
      }
      const tx = await this.conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      out.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, events: parseVaultEvents(tx?.meta?.logMessages ?? [], this.ids.vault), ok: true });
    }
    return out;
  }

  // ───────────────────────────────────────── transaction plans for the user's wallet

  async depositPlan(owner: PublicKey, mint: string, units: bigint, label: string): Promise<TxPlan[]> {
    const a = this.asset(mint);
    const vault = this.vaultOf(owner);
    const v = await this.maybeVault(vault);
    const ixs: TransactionInstruction[] = [];
    if (!v) ixs.push(this.client.vaultIx.initVault(owner, 0n));
    if (!v?.balances.some((b) => b.mint.equals(a.mintKey))) ixs.push(...(await this.client.registerMintIxs(owner, vault, a.mintKey, a.program)).ixs);
    ixs.push(this.client.vaultIx.deposit(owner, vault, a.mintKey, ata(owner, a.mintKey, a.program), ata(vault, a.mintKey, a.program), a.program, units));
    return [{ label, effect: "Moves funds from your wallet to available in your vault", ixs }];
  }

  async withdrawPlan(owner: PublicKey, mint: string, units: bigint, label: string): Promise<TxPlan[]> {
    const a = this.asset(mint);
    const vault = this.vaultOf(owner);
    const v = await this.maybeVault(vault);
    const entry = v?.balances.find((b) => b.mint.equals(a.mintKey));
    if (!entry) throw new ChainError("Your vault holds none of this asset.");
    if (units > entry.available) throw new ChainError("Only funds marked available can be withdrawn. Reserved funds return when their future releases them.");
    const dest = ata(owner, a.mintKey, a.program);
    return [
      {
        label,
        effect: "Moves funds from available to your wallet",
        ixs: [createAssociatedTokenAccountIdempotentInstruction(owner, dest, owner, a.mintKey, a.program), this.client.vaultIx.withdraw(owner, vault, a.mintKey, entry.tokenAccount, dest, a.program, units)],
      },
    ];
  }

  /**
   * create_strategy → write_plan × n → activate_strategy. Resumable: if a
   * previous attempt created the account (same hash, still uploading), the
   * upload continues from what's already written. An old version to replace
   * is cancelled in the same transaction as the activation, so there's never
   * a moment with both or neither reserved.
   */
  async authorizePlan(o: { creator: PublicKey; vault: PublicKey; strategyId: bigint; version: number; bytes: Uint8Array; policy?: PublicKey; supersede?: PublicKey }): Promise<{ strategy: PublicKey; txs: TxPlan[] }> {
    const hash = sha256Bytes(o.bytes);
    const { strategy, ix } = this.client.vaultIx.createStrategy(o.creator, o.vault, o.strategyId, o.version, o.bytes.length, hash, o.policy);
    const existing = await this.maybeStrategy(strategy);
    const txs: TxPlan[] = [];
    let written = 0;
    if (existing) {
      if (existing.status !== 0) throw new ChainError("A future with this id is already active. Start a new version instead.");
      if (Buffer.compare(Buffer.from(existing.planHash), Buffer.from(hash)) !== 0) throw new ChainError("A different plan was already uploaded under this id. Start a new version.");
      written = existing.written;
    } else {
      txs.push({ label: "Create the future's account", effect: "Commits the plan hash; nothing is reserved yet", ixs: [ix] });
    }
    // the vault needs a canonical token account for every mint the plan can receive or spend
    const plan0 = decodePlan(o.bytes);
    const v = await this.maybeVault(o.vault);
    const missing = plan0.mints.filter((m) => !v?.balances.some((b) => b.mint.toBase58() === m));
    if (missing.length) {
      const ixs: TransactionInstruction[] = [];
      for (const m of missing) {
        const a = this.asset(m);
        ixs.push(...(await this.client.registerMintIxs(o.creator, o.vault, a.mintKey, a.program)).ixs);
      }
      txs.unshift({ label: `Open vault token accounts (${missing.map((m) => this.asset(m).key).join(", ")})`, effect: "Creates your vault's own token accounts for the assets this plan can hold", ixs });
    }
    const chunks = chunkPlan(o.bytes, 800).filter((c) => c.offset >= written);
    chunks.forEach((c, i) => txs.push({ label: `Upload plan (part ${i + 1} of ${chunks.length})`, ixs: [this.client.vaultIx.writePlan(o.creator, strategy, c.offset, c.data)] }));
    const plan = decodePlan(o.bytes);
    const remaining = [...plan.events, ...plan.refs].map((a) => new PublicKey(a));
    const activate = this.client.vaultIx.activateStrategy(o.creator, o.vault, strategy, remaining, o.policy);
    txs.push({
      label: o.supersede ? "Replace previous version and reserve" : "Activate and reserve",
      effect: "The program checks the uploaded bytes against the signed hash, then reserves the allocations",
      ixs: o.supersede ? [this.client.vaultIx.cancelStrategy(o.creator, o.vault, o.supersede), activate] : [activate],
    });
    return { strategy, txs };
  }

  pausePlan(owner: PublicKey, strategy: PublicKey, paused: boolean): TxPlan[] {
    return [{ label: paused ? "Pause new steps" : "Resume", effect: paused ? "Stops new steps; funds stay reserved" : "Allows steps to execute again", ixs: [this.client.vaultIx.pauseStrategy(owner, this.vaultOf(owner), strategy, paused)] }];
  }

  cancelPlan(owner: PublicKey, strategy: PublicKey): TxPlan[] {
    return [{ label: "Cancel and release", effect: "Returns everything unspent to available", ixs: [this.client.vaultIx.cancelStrategy(owner, this.vaultOf(owner), strategy)] }];
  }

  createPolicyPlan(owner: PublicKey, sessionKey: PublicKey, args: PolicyArgs, label: string): { policy: PublicKey; txs: TxPlan[] } {
    const { policy, ix } = this.client.vaultIx.createPolicy(owner, this.vaultOf(owner), sessionKey, args);
    return { policy, txs: [{ label: `Grant “${label}”`, effect: "An agent session key may create futures within these limits; it can never withdraw", ixs: [ix] }] };
  }

  revokePolicyPlan(owner: PublicKey, policy: PublicKey): TxPlan[] {
    return [{ label: "Revoke agent policy", effect: "The session key loses all authority", ixs: [this.client.vaultIx.revokePolicy(owner, policy)] }];
  }

  killSwitchPlan(owner: PublicKey): TxPlan[] {
    return [{ label: "Kill switch", effect: "Voids every agent policy for this vault at once", ixs: [this.client.vaultIx.killSwitch(owner, this.vaultOf(owner))] }];
  }

  /** Compile plans into exact message bytes with one fresh blockhash; fee payer = the signer. */
  async compile(plans: TxPlan[], feePayer: PublicKey): Promise<CompiledTx[]> {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    return plans.map((p) => {
      const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight });
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: p.computeUnits ?? 400_000 }), ...p.ixs);
      return { label: p.label, ...(p.effect ? { effect: p.effect } : {}), message: tx.serializeMessage(), blockhash, lastValidBlockHeight };
    });
  }

  /** Attach a wallet signature to exact message bytes; refuses a signature that doesn't verify. */
  static attach(message: Buffer, signer: string, signatureB58: string): Buffer {
    const msg = Message.from(message);
    const required = msg.accountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
    if (required.length !== 1 || required[0] !== signer) throw new ChainError("This transaction must be signed by your wallet alone.");
    const tx = Transaction.populate(msg, [signatureB58]);
    if (!tx.verifySignatures(true)) throw new ChainError("The wallet signature doesn't verify for this transaction.");
    if (Buffer.compare(tx.serializeMessage(), message) !== 0) throw new ChainError("Transaction bytes changed after signing.");
    return tx.serialize();
  }

  /** Send a signed transaction and wait for confirmation (or blockhash expiry). */
  async sendSigned(raw: Buffer, blockhash: string, lastValidBlockHeight: number, onSubmitted?: (signature: string) => void): Promise<SendOutcome> {
    let signature: string;
    try {
      signature = await this.conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 });
    } catch (e) {
      let logs: string[] = [];
      if (e instanceof SendTransactionError) logs = (await e.getLogs(this.conn).catch(() => null)) ?? e.logs ?? [];
      const msg = String((e as Error).message ?? e);
      if (/Blockhash not found|block height exceeded/i.test(msg)) return { ok: false, logs, events: [], expired: true, error: "The transaction expired before it landed. Nothing changed; try again." };
      const code = errorCodeFrom((e as { transactionError?: unknown }).transactionError ?? msg, logs);
      const name = code !== undefined ? vaultErrorName(code) : undefined;
      return { ok: false, logs, events: [], ...(code !== undefined ? { code } : {}), error: explainError(name, msg.split("\n")[0]!.slice(0, 300)) };
    }
    onSubmitted?.(signature);
    try {
      const conf = await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      const info = await this.conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const logs = info?.meta?.logMessages ?? [];
      if (conf.value.err || info?.meta?.err) {
        const code = errorCodeFrom(conf.value.err ?? info?.meta?.err, logs);
        return { ok: false, signature, slot: info?.slot ?? 0, logs, events: [], ...(code !== undefined ? { code } : {}), error: explainError(code !== undefined ? vaultErrorName(code) : undefined, JSON.stringify(conf.value.err ?? info?.meta?.err)) };
      }
      return { ok: true, signature, slot: info?.slot ?? 0, logs, events: parseVaultEvents(logs, this.ids.vault) };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/expired|block height exceeded/i.test(msg)) {
        // last check: it may have landed right at the edge
        const st = await this.conn.getSignatureStatus(signature, { searchTransactionHistory: true }).catch(() => null);
        if (st?.value && !st.value.err) return { ok: true, signature, slot: st.value.slot, logs: [], events: [] };
        return { ok: false, signature, logs: [], events: [], expired: true, error: "The transaction expired before it landed. Nothing changed; try again." };
      }
      throw e;
    }
  }

  /** Server-held signer (keeper, localnet admin, agent session key): build, sign and send in one go. */
  async sendAs(signer: Keypair, ixs: TransactionInstruction[], o: { computeUnits?: number } = {}): Promise<SendOutcome> {
    const r = await this.client.send(ixs, [signer], { computeUnits: o.computeUnits ?? 600_000 });
    return { ok: r.ok, ...(r.signature ? { signature: r.signature } : {}), logs: r.logs, events: r.events, ...(r.code !== undefined ? { code: r.code } : {}), ...(r.error ? { error: explainError(r.code !== undefined ? vaultErrorName(r.code) : undefined, r.error) } : {}) };
  }

  async signatureStatus(signature: string) {
    return (await this.conn.getSignatureStatus(signature, { searchTransactionHistory: true })).value;
  }

  async blockHeight(): Promise<number> {
    return this.conn.getBlockHeight("confirmed");
  }

  // ───────────────────────────────────────── keeper (permissionless cranks)

  async execute(vault: PublicKey, strategy: PublicKey, action: number, run: number): Promise<SendOutcome> {
    const r = await this.client.execute(this.keeper, vault, strategy, action, run);
    return { ok: r.ok, ...(r.signature ? { signature: r.signature } : {}), logs: r.logs, events: r.events, ...(r.code !== undefined ? { code: r.code } : {}), ...(r.error ? { error: r.error } : {}) };
  }

  async closeExpired(vault: PublicKey, strategy: PublicKey): Promise<SendOutcome> {
    return this.sendAs(this.keeper, [this.client.vaultIx.closeExpired(vault, strategy)]);
  }

  async closeCompleted(vault: PublicKey, strategy: PublicKey): Promise<SendOutcome> {
    const r = await this.client.closeCompleted(this.keeper, vault, strategy);
    return { ok: r.ok, ...(r.signature ? { signature: r.signature } : {}), logs: r.logs, events: r.events, ...(r.code !== undefined ? { code: r.code } : {}), ...(r.error ? { error: r.error } : {}) };
  }

  async observeBalance(event: PublicKey, watched: PublicKey): Promise<SendOutcome> {
    return this.sendAs(this.keeper, [this.client.vaultIx.observeBalance(event, watched)]);
  }

  async finalizeEvent(event: PublicKey): Promise<SendOutcome> {
    return this.sendAs(this.keeper, [this.client.vaultIx.finalizeEvent(event)]);
  }

  // ───────────────────────────────────────── localnet development controls

  private requireLocal(what: string): Keypair {
    if (!this.local || !this.admin) throw new ChainError(`${what} is only available on a local validator.`);
    return this.admin;
  }

  /** Test SOL + test tokens for a local development wallet. */
  async airdrop(owner: PublicKey, o: { sol?: number; tokens?: Record<string, bigint> } = {}): Promise<void> {
    const admin = this.requireLocal("Airdrop");
    if ((await this.lamports(owner)) < 2 * LAMPORTS_PER_SOL) {
      const sig = await this.conn.requestAirdrop(owner, (o.sol ?? 10) * LAMPORTS_PER_SOL);
      const bh = await this.conn.getLatestBlockhash("confirmed");
      await this.conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    }
    const tokens = o.tokens ?? { USDC: 2_500_000_000n, MAYBE: 40_000_000_000n };
    const ixs: TransactionInstruction[] = [];
    const current = await this.walletBalances(owner);
    for (const [key, units] of Object.entries(tokens)) {
      const a = this.book.assets[key];
      if (!a) continue;
      const mint = new PublicKey(a.mint);
      const tp = new PublicKey(a.tokenProgram);
      if ((current[a.mint] ?? 0n) >= units) continue;
      const dest = ata(owner, mint, tp);
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, dest, owner, mint, tp), createMintToInstruction(mint, dest, admin.publicKey, units - (current[a.mint] ?? 0n), [], tp));
    }
    if (ixs.length) {
      const r = await this.sendAs(admin, ixs);
      if (!r.ok) throw new ChainError(`Airdrop failed: ${r.error}`);
    }
  }

  async fundSol(k: PublicKey, sol = 2): Promise<void> {
    this.requireLocal("Funding");
    const sig = await this.conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL);
    const bh = await this.conn.getLatestBlockhash("confirmed");
    await this.conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }

  /** k-of-n development attestation (the on-chain set requires 2 of 3). */
  async devAttest(eventKey: string, outcome: 0 | 1 | 2, signers: number[] = [0, 1]): Promise<SendOutcome> {
    const admin = this.requireLocal("Development attestation");
    if (!this.attestors.length) throw new ChainError("Development attestors are disabled.");
    const ev = Object.values(this.book.events).find((e) => e.address === eventKey);
    if (!ev || ev.adapter !== 1) throw new ChainError("Not an attestation event.");
    const event = new PublicKey(ev.address);
    const acct = decodeOutcomeEvent((await this.client.account(event)).data);
    const now = await this.clock();
    const nonce = acct.lastNonce + 1n;
    const fields = { programId: this.ids.vault, event, ruleHash: Buffer.from(ev.ruleHash, "hex"), outcome, observedAt: now, nonce, expiresAt: now + 300 };
    const msg = attestationMessage(fields);
    const keys = signers.map((i) => this.attestors[i]!.secretKey);
    return this.sendAs(admin, [...ed25519Instructions(msg, keys), this.client.vaultIx.attest(event, new PublicKey(this.book.attestorSet.address), outcome, now, nonce, now + 300)]);
  }

  /** Put test tokens into a watched account (localnet) so an objective balance event can be observed. */
  async devFundWatched(watchedKey: string, units: bigint): Promise<void> {
    const admin = this.requireLocal("Funding a watched account");
    const w = this.book.watched[watchedKey];
    if (!w) throw new ChainError("Unknown watched account.");
    const mint = new PublicKey(w.mint);
    const asset = Object.values(this.book.assets).find((a) => a.mint === w.mint);
    const tp = new PublicKey(asset?.tokenProgram ?? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const r = await this.sendAs(admin, [createMintToInstruction(mint, new PublicKey(w.address), admin.publicKey, units, [], tp)]);
    if (!r.ok) throw new ChainError(`Mint failed: ${r.error}`);
  }

  async devSetPaused(paused: boolean): Promise<SendOutcome> {
    const admin = this.requireLocal("Emergency pause");
    return this.sendAs(admin, [this.client.vaultIx.setPaused(admin.publicKey, paused)]);
  }

  /** Generate a session key for an agent policy. Localnet only: production keys belong in a KMS. */
  newSessionKey(): Keypair {
    this.requireLocal("Server-held agent session keys");
    return Keypair.generate();
  }
}

export { decodeConfig };
