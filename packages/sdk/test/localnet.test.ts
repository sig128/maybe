/**
 * Integration tests against a running solana-test-validator with the real
 * SBF programs. Every execution is predicted by the shared TypeScript engine
 * first and the on-chain result must match it exactly (receipt, strategy state,
 * vault ledger, token balances).
 *
 *   scripts/validator.sh && npx tsx scripts/localnet-setup.ts && npx vitest run --project sdk
 *
 * Tests run in file order and share the seeded ledger. The last test disables
 * development attestors (one-way), so re-run setup (the validator script resets
 * the ledger) before running the suite again.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, type AccountMeta } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent, mintTo } from "@solana/spl-token";
import {
  applyOp,
  buildFixtures,
  checkVaultInvariants,
  closeStrategy,
  compileStrategy,
  cpQuote,
  eventRefFor,
  executeAction,
  holdingsByMint,
  SimVenue,
  sha256Bytes,
  templateById,
  RouteKind,
  type ChainContext,
  type EventView,
  type Plan,
  type Strategy,
  type StrategyState,
  type VaultState,
} from "@maybe/core";
import {
  ADJUDICATE_DOMAIN,
  MaybeClient,
  ata,
  attestationMessage,
  decodeOutcomeMarket,
  decodePool,
  ed25519Instructions,
  loadLocalnetBook,
  localnetKeypair,
  toCoreAddressBook,
  toEventView,
  toStrategyState,
  toVaultState,
  type ExecutionReceiptEvent,
  type LocalnetBook,
  type TxResult,
} from "../src/index.ts";

const RPC = process.env.MAYBE_RPC ?? "http://127.0.0.1:8899";
async function validatorUp(): Promise<boolean> {
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) });
    return ((await r.json()) as { result?: string }).result === "ok";
  } catch {
    return false;
  }
}
const book = loadLocalnetBook();
const ready = (await validatorUp()) && book !== null;
if (!ready) console.warn("[sdk localnet tests] SKIPPED: no validator on " + RPC + " or no .localnet/localnet.json — run scripts/validator.sh && npx tsx scripts/localnet-setup.ts");

const T = { timeout: 180_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

describe.skipIf(!ready)("maybe_vault on a local validator", () => {
  const b = book as LocalnetBook;
  const conn = new Connection(RPC, "confirmed");
  const client = new MaybeClient(conn);
  const admin = localnetKeypair("admin");
  const keeper = localnetKeypair("keeper");
  const attestors = [1, 2, 3].map((i) => localnetKeypair(`dev_attestor_${i}`));
  const attestorSet = new PublicKey(b.attestorSet.address);
  const fx = buildFixtures(Math.floor(Date.now() / 1000), toCoreAddressBook(b), "localnet");
  const mint = (k: string) => new PublicKey(b.assets[k]!.mint);
  const tp = (k: string) => new PublicKey(b.assets[k]!.tokenProgram);
  let ids = 0;
  const env = () => ({ now: Math.floor(Date.now() / 1000), fixtures: fx, id: () => `it_${Date.now()}_${ids++}`, nonce: () => String(BigInt(Date.now()) * 1000n + BigInt(ids++)) });
  let nonce = BigInt(Date.now()) * 1000n;

  async function airdrop(k: PublicKey, sol = 5) {
    const sig = await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, "confirmed");
  }
  async function ok(p: Promise<TxResult> | TxResult, label = "tx"): Promise<TxResult> {
    const r = await p;
    if (!r.ok) throw new Error(`${label} failed: ${r.error}\n${r.logs.slice(-10).join("\n")}`);
    return r;
  }
  async function chainNow(): Promise<number> {
    for (let i = 0; i < 10; i++) {
      const t = await conn.getBlockTime(await conn.getSlot("confirmed"));
      if (t) return t;
      await sleep(200);
    }
    return Math.floor(Date.now() / 1000);
  }

  interface User {
    user: Keypair;
    vault: PublicKey;
    wallet: Record<string, PublicKey>;
  }
  async function newUser(fundUsdc = 2_000_000_000n): Promise<User> {
    const user = Keypair.generate();
    await airdrop(user.publicKey);
    const vault = client.pdas.vault(user.publicKey, 0n);
    await ok(client.send([client.vaultIx.initVault(user.publicKey, 0n)], [user]), "init_vault");
    const listed = Object.entries(b.assets).filter(([, a]) => a.listed);
    for (let i = 0; i < listed.length; i += 2) {
      const ixs = [];
      for (const [, a] of listed.slice(i, i + 2)) ixs.push(...(await client.registerMintIxs(user.publicKey, vault, new PublicKey(a.mint), new PublicKey(a.tokenProgram))).ixs);
      await ok(client.send(ixs, [user]), "register_mint");
    }
    const wallet: Record<string, PublicKey> = {};
    for (const k of ["USDC", "MAYBE"]) wallet[k] = await createAssociatedTokenAccountIdempotent(conn, admin, mint(k), user.publicKey, { commitment: "confirmed" }, tp(k));
    await mintTo(conn, admin, mint("USDC"), wallet.USDC!, admin, fundUsdc, [], { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    return { user, vault, wallet };
  }
  async function deposit(u: User, k: string, amount: bigint) {
    const v = await client.vault(u.vault);
    const e = v.balances.find((x) => x.mint.equals(mint(k)))!;
    return client.send([client.vaultIx.deposit(u.user.publicKey, u.vault, mint(k), u.wallet[k]!, e.tokenAccount, tp(k), amount)], [u.user]);
  }

  async function attest(eventKey: string, outcome: number, o: { signers?: Keypair[]; nonce?: bigint; expiresAt?: number; domain?: Buffer; payer?: Keypair } = {}) {
    const event = new PublicKey(b.events[eventKey]!.address);
    const e = await client.event(event);
    const n = o.nonce ?? ++nonce;
    const observedAt = Math.floor(Date.now() / 1000);
    const expiresAt = o.expiresAt ?? observedAt + 600;
    const msg = attestationMessage({ programId: client.ids.vault, event, ruleHash: e.ruleHash, outcome, observedAt, nonce: n, expiresAt }, o.domain);
    const sigs = ed25519Instructions(msg, (o.signers ?? attestors.slice(0, 2)).map((k) => k.secretKey));
    return client.send([...sigs, client.vaultIx.attest(event, attestorSet, outcome, observedAt, n, expiresAt)], [o.payer ?? admin]);
  }
  async function waitFinal(eventKey: string) {
    const event = new PublicKey(b.events[eventKey]!.address);
    for (let i = 0; i < 40; i++) {
      const e = await client.event(event);
      if (e.status === 3 || (e.status === 1 && (await chainNow()) >= e.finalAt)) return;
      await sleep(500);
    }
    throw new Error(`event ${eventKey} did not become final`);
  }

  interface Snapshot {
    s: StrategyState;
    v: VaultState;
    events: Record<string, EventView>;
    others: Record<string, StrategyState>;
  }
  async function snapshot(strategy: PublicKey, vault: PublicKey): Promise<Snapshot> {
    const s = toStrategyState(strategy, await client.strategy(strategy))!;
    const vAcc = await client.vault(vault);
    const tokens: Record<string, bigint> = {};
    for (const x of vAcc.balances) tokens[x.mint.toBase58()] = await client.tokenAmount(x.tokenAccount);
    const events: Record<string, EventView> = {};
    for (const e of s.plan.events) events[e] = toEventView(await client.event(new PublicKey(e)));
    return { s, v: toVaultState(vault, vAcc, tokens), events, others: {} };
  }
  async function venueFromChain(plan: Plan): Promise<SimVenue> {
    const cp: SimVenue["state"]["cp"] = {};
    const outcome: SimVenue["state"]["outcome"] = {};
    const outcomes: Record<string, "YES" | "NO" | "VOID" | null> = {};
    for (const a of plan.actions) {
      if (a.kind !== 1) continue;
      const ref = new PublicKey(plan.refs[a.ref]!);
      const info = await client.account(ref);
      if (a.routeKind === RouteKind.CP_SWAP) {
        const p = decodePool(info.data);
        cp[ref.toBase58()] = { address: ref.toBase58(), mintA: p.mintA.toBase58(), mintB: p.mintB.toBase58(), reserveA: await client.tokenAmount(p.vaultA), reserveB: await client.tokenAmount(p.vaultB), feeBps: p.feeBps };
      } else {
        const m = decodeOutcomeMarket(info.data);
        outcome[ref.toBase58()] = { address: ref.toBase58(), event: m.event.toBase58(), collateralMint: m.collateralMint.toBase58(), yesMint: m.yesMint.toBase58(), yesPriceE6: m.yesPriceE6 };
        const ev = toEventView(await client.event(m.event));
        const fin = ev.status === "FINAL" || (ev.status === "PENDING" && ev.finalAt !== null && (await chainNow()) >= ev.finalAt);
        outcomes[m.event.toBase58()] = fin ? (ev.outcome as "YES" | "NO" | "VOID") : null;
      }
    }
    return new SimVenue({ cp, outcome, eventOutcome: (e) => outcomes[e] ?? null });
  }
  function reconcile(v: VaultState, strategies: StrategyState[]) {
    expect(checkVaultInvariants(v, holdingsByMint(strategies))).toEqual([]);
  }

  /** Predict with the core engine, execute on-chain, require identical results. */
  async function executeExpect(strategy: PublicKey, vault: PublicKey, action: number, run: number, opts: { override?: (m: AccountMeta[]) => AccountMeta[]; planHash?: Uint8Array; expectError?: string } = {}) {
    const before = await snapshot(strategy, vault);
    const venue = await venueFromChain(before.s.plan);
    let res: TxResult | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      res = await client.execute(keeper, vault, strategy, action, run, opts);
      if (res.ok || res.error !== "GuardPending" || opts.expectError === "GuardPending") break;
      await sleep(1000);
    }
    const r = res!;
    if (opts.expectError) {
      expect(r.ok, `expected ${opts.expectError}`).toBe(false);
      expect(r.error).toBe(opts.expectError);
      const after = await snapshot(strategy, vault);
      expect(after.s).toEqual(before.s);
      expect(after.v).toEqual(before.v);
      return { r, before, after };
    }
    if (!r.ok) throw new Error(`execute ${action}/${run} failed: ${r.error}\n${r.logs.slice(-12).join("\n")}`);
    const receipt = r.events.find((e) => e.name === "ExecutionReceipt") as ExecutionReceiptEvent;
    const ctx: ChainContext = { now: receipt.at, executionPaused: false, events: before.events, strategies: before.others };
    const pred = executeAction(before.v, before.s, action, ctx, venue, { expectedPlanHash: before.s.planHash, expectedRun: run });
    if (!pred.ok) throw new Error(`engine predicted failure ${pred.code} but chain executed`);
    expect({ amount: receipt.amount, fee: receipt.fee, amountIn: receipt.amountIn, amountOut: receipt.amountOut, run: receipt.run, nonce: Number(receipt.execNonce) }).toEqual({
      amount: pred.receipt.amount,
      fee: pred.receipt.fee,
      amountIn: pred.receipt.amountIn,
      amountOut: pred.receipt.amountOut,
      run: pred.receipt.run,
      nonce: pred.receipt.execNonce,
    });
    const after = await snapshot(strategy, vault);
    expect(after.s).toEqual(pred.strategy);
    expect(after.v).toEqual(pred.vault);
    reconcile(after.v, [after.s]);
    return { r, receipt, before, after };
  }

  async function activate(u: User, doc: Strategy, id: bigint, creator: Keypair = u.user, policy?: PublicKey) {
    const c = compileStrategy(doc);
    const out = await client.uploadAndActivate(creator, u.vault, id, doc.version, c.bytes, policy);
    return { ...out, compiled: c, last: out.results[out.results.length - 1]! };
  }

  function withEvents(doc: Strategy, map: Record<string, string>): Strategy {
    let d = doc;
    for (const [ref, key] of Object.entries(map)) d = applyOp(d, { op: "replaceEvent", ref, event: eventRefFor(fx.markets.find((m) => m.key === key)!, ref) });
    return d;
  }

  let shared: User;
  beforeAll(async () => {
    shared = await newUser();
  }, 120_000);

  it("flagship: deposit 500 → reserve 300 + 200 → A YES buys portfolio A → B AND C buys MAYBE → close → withdraw, matching the engine exactly", T, async () => {
    const u = shared;
    await ok(deposit(u, "USDC", 500_000_000n), "deposit");
    const doc = templateById("flagship")!.build(env());
    const { strategy, last } = await activate(u, doc, 1n);
    await ok(last, "activate");
    let snap = await snapshot(strategy, u.vault);
    expect(snap.v.balances[mint("USDC").toBase58()]).toEqual({ available: 0n, reserved: 500_000_000n });
    reconcile(snap.v, [snap.s]);
    // before any outcome: nothing can run
    await executeExpect(strategy, u.vault, 0, 0, { expectError: "GuardPending" });
    await ok(attest("orbit-launch", 1), "attest A YES");
    await waitFinal("orbit-launch");
    await executeExpect(strategy, u.vault, 0, 0);
    await executeExpect(strategy, u.vault, 1, 0);
    // the A-NO branch is now locked out and A is YES: release can never run
    await executeExpect(strategy, u.vault, 2, 0, { expectError: "BranchLost" });
    // duplicate execution of an executed (action, run) is rejected
    await executeExpect(strategy, u.vault, 0, 0, { expectError: "ActionComplete" });
    await ok(attest("treasury-prop", 1), "attest B YES");
    await ok(attest("ravens-cup", 1), "attest C YES");
    await waitFinal("treasury-prop");
    await waitFinal("ravens-cup");
    await executeExpect(strategy, u.vault, 3, 0);
    snap = await snapshot(strategy, u.vault);
    const close = await ok(client.closeCompleted(keeper, u.vault, strategy), "close_completed");
    const closed = close.events.find((e) => e.name === "StrategyClosed");
    expect(closed).toBeTruthy();
    const predClose = closeStrategy(snap.v, snap.s, "COMPLETE", { now: await chainNow(), executionPaused: false, events: snap.events, strategies: {} });
    expect(predClose.ok).toBe(true);
    const after = await snapshot(strategy, u.vault);
    expect(after.s.status).toBe("COMPLETED");
    if (predClose.ok) expect(after.v).toEqual(predClose.vault);
    reconcile(after.v, []);
    // everything bought is now available; withdraw the LUMEN position
    const lumen = after.v.balances[mint("LUMEN").toBase58()]!;
    expect(lumen.available > 0n && lumen.reserved === 0n).toBe(true);
    const dest = await createAssociatedTokenAccountIdempotent(conn, admin, mint("LUMEN"), u.user.publicKey, { commitment: "confirmed" }, tp("LUMEN"));
    const vLumen = (await client.vault(u.vault)).balances.find((x) => x.mint.equals(mint("LUMEN")))!;
    await ok(client.send([client.vaultIx.withdraw(u.user.publicKey, u.vault, mint("LUMEN"), vLumen.tokenAccount, dest, tp("LUMEN"), lumen.available)], [u.user]), "withdraw");
    expect(await client.tokenAmount(dest)).toBe(lumen.available);
  });

  it("refund path: A resolves NO releases 300 at once; C NO makes B∧C impossible; everything returns and withdraws to the wallet", T, async () => {
    const u = await newUser();
    const start = await client.tokenAmount(u.wallet.USDC!);
    await ok(deposit(u, "USDC", 500_000_000n));
    const doc = withEvents(templateById("flagship")!.build(env()), { A: "night-transit", B: "fern-beta", C: "gallery-vote" });
    const { strategy, last } = await activate(u, doc, 2n);
    await ok(last, "activate");
    await ok(attest("night-transit", 0), "A NO");
    await ok(attest("fern-beta", 1), "B YES");
    await ok(attest("gallery-vote", 0), "C NO");
    await waitFinal("night-transit");
    await waitFinal("gallery-vote");
    await executeExpect(strategy, u.vault, 0, 0, { expectError: "GuardFalse" });
    await executeExpect(strategy, u.vault, 2, 0); // release 300
    await executeExpect(strategy, u.vault, 3, 0, { expectError: "GuardFalse" });
    await ok(client.closeCompleted(keeper, u.vault, strategy), "close");
    const v = await client.vault(u.vault);
    const e = v.balances.find((x) => x.mint.equals(mint("USDC")))!;
    expect([e.available, e.reserved]).toEqual([500_000_000n, 0n]);
    await ok(client.send([client.vaultIx.withdraw(u.user.publicKey, u.vault, mint("USDC"), e.tokenAccount, u.wallet.USDC!, TOKEN_PROGRAM_ID, 500_000_000n)], [u.user]), "withdraw");
    expect(await client.tokenAmount(u.wallet.USDC!)).toBe(start);
  });

  it("malicious allowlisted routes are rejected with no state change; vault-owned accounts in route slots are refused", T, async () => {
    const u = await newUser();
    await ok(deposit(u, "USDC", 400_000_000n));
    const usdc = mint("USDC").toBase58();
    const lumen = mint("LUMEN").toBase58();
    const expectations: Record<string, string> = { overspend: "RouteDeltaViolation", underdeliver: "MinOutNotMet", redirect: "MinOutNotMet" };
    let id = 10n;
    for (const [mode, code] of Object.entries(expectations)) {
      const pool = b.maliciousPools[mode]!;
      const p = decodePool((await client.account(new PublicKey(pool.address))).data);
      const q = cpQuote({ address: pool.address, mintA: p.mintA.toBase58(), mintB: p.mintB.toBase58(), reserveA: await client.tokenAmount(p.vaultA), reserveB: await client.tokenAmount(p.vaultB), feeBps: p.feeBps }, usdc, (100_000_000n * 9970n) / 10_000n);
      const doc = applyOp(templateById("yes-buys-token")!.build(env()), { op: "setActionOutput", actionId: "buy", outputMint: lumen, pool: pool.address, minOut: { kind: "absolute", amount: ((q * 99n) / 100n).toString() } });
      const { strategy, last } = await activate(u, doc, id++);
      await ok(last, `activate ${mode}`);
      await executeExpect(strategy, u.vault, 0, 0, { expectError: code });
    }
    // touch_other venue: an honest swap is all it can do — the vault never forwards extra accounts…
    const doc = applyOp(templateById("yes-buys-token")!.build(env()), { op: "setActionOutput", actionId: "buy", outputMint: lumen, pool: b.maliciousPools.touch_other!.address, minOut: { kind: "absolute", amount: "1" } });
    const { strategy, last } = await activate(u, doc, id++);
    await ok(last, "activate touch_other");
    // …and if a keeper substitutes the vault's own token account into a pool slot, the vault refuses before the CPI
    const vAcc = await client.vault(u.vault);
    const vaultUsdc = vAcc.balances.find((x) => x.mint.equals(mint("USDC")))!.tokenAccount;
    const ctxLen = (await client.strategy(strategy)).plan ? 1 : 0; // one event in this plan
    await executeExpect(strategy, u.vault, 0, 0, {
      expectError: "ForeignVaultAccountInRoute",
      override: (m) => m.map((x, i) => (i === ctxLen + 4 ? { ...x, pubkey: vaultUsdc } : x)), // pool_vault_a slot
    });
    await executeExpect(strategy, u.vault, 0, 0); // and the plain call succeeds
  });

  it("account substitution and authorization checks", T, async () => {
    const u = await newUser();
    const other = await newUser();
    await ok(deposit(u, "USDC", 200_000_000n));
    const doc = templateById("yes-buys-token")!.build(env());
    const { strategy, last } = await activate(u, doc, 20n);
    await ok(last);
    const vu = await client.vault(u.vault);
    const usdcEntry = vu.balances.find((x) => x.mint.equals(mint("USDC")))!;
    // withdrawing reserved funds is impossible (only 100 available)
    const w = await client.send([client.vaultIx.withdraw(u.user.publicKey, u.vault, mint("USDC"), usdcEntry.tokenAccount, u.wallet.USDC!, TOKEN_PROGRAM_ID, 100_000_001n)], [u.user]);
    expect(w.error).toBe("InsufficientAvailable");
    // a stranger cannot withdraw or deposit into someone else's vault
    const w2 = await client.send([client.vaultIx.withdraw(other.user.publicKey, u.vault, mint("USDC"), usdcEntry.tokenAccount, other.wallet.USDC!, TOKEN_PROGRAM_ID, 1n)], [other.user]);
    expect(w2.error).toBe("NotOwner");
    // depositing into a non-registered token account is refused
    const d = await client.send([client.vaultIx.deposit(u.user.publicKey, u.vault, mint("USDC"), u.wallet.USDC!, u.wallet.USDC!, TOKEN_PROGRAM_ID, 1n)], [u.user]);
    expect(d.error).toBe("TokenAccountMismatch");
    // mint / token-account mismatch
    const d2 = await client.send([client.vaultIx.deposit(u.user.publicKey, u.vault, mint("LUMEN"), u.wallet.USDC!, usdcEntry.tokenAccount, TOKEN_PROGRAM_ID, 1n)], [u.user]);
    expect(d2.error).toBe("TokenAccountMismatch");
    // execute against the wrong vault, with a substituted event, or with a stale plan hash
    await executeExpect(strategy, u.vault, 0, 0, { expectError: "PlanHashMismatch", planHash: new Uint8Array(32) });
    await executeExpect(strategy, u.vault, 0, 0, { expectError: "EventMismatch", override: (m) => m.map((x, i) => (i === 0 ? { ...x, pubkey: new PublicKey(b.events["data-center"]!.address) } : x)) });
    const wrongVault = await client.send([client.vaultIx.executeAction(keeper.publicKey, other.vault, strategy, 0, 0, (await client.strategy(strategy)).planHash, [])], [keeper]);
    expect(wrongVault.error).toBe("InvalidAccount");
    // only the creator can write or activate a plan
    const c = compileStrategy(templateById("yes-buys-token")!.build(env()));
    const { strategy: s2, ix } = client.vaultIx.createStrategy(u.user.publicKey, u.vault, 21n, 1, c.bytes.length, sha256Bytes(c.bytes));
    await ok(client.send([ix], [u.user]));
    const wp = await client.send([client.vaultIx.writePlan(other.user.publicKey, s2, 0, c.bytes.slice(0, 100))], [other.user]);
    expect(wp.error).toBe("Unauthorized");
    // the owner can cancel: everything reserved returns
    await ok(client.send([client.vaultIx.cancelStrategy(u.user.publicKey, u.vault, strategy)], [u.user]), "cancel");
    const v2 = await client.vault(u.vault);
    expect(v2.balances.find((x) => x.mint.equals(mint("USDC")))!.available).toBe(200_000_000n);
  });

  it("conditional payment goes only to the fixed recipient's token account", T, async () => {
    const u = await newUser();
    await ok(deposit(u, "USDC", 250_000_000n));
    const recipient = Keypair.generate();
    const recipientAta = await createAssociatedTokenAccountIdempotent(conn, admin, mint("USDC"), recipient.publicKey, { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    const doc = templateById("conditional-payment")!.build({ ...env(), recipient: recipient.publicKey.toBase58() });
    const { strategy, last } = await activate(u, doc, 30n);
    await ok(last);
    await ok(attest("harbor-bridge", 1));
    await waitFinal("harbor-bridge");
    // redirecting to another wallet's token account is refused
    await executeExpect(strategy, u.vault, 0, 0, { expectError: "TokenAccountMismatch", override: (m) => m.map((x, i) => (i === 3 ? { ...x, pubkey: u.wallet.USDC! } : x)) });
    await executeExpect(strategy, u.vault, 0, 0);
    expect(await client.tokenAmount(recipientAta)).toBe(250_000_000n);
  });

  it("prediction proceeds: buy YES, redeem after A resolves YES, recycle 25% of what was actually redeemed", T, async () => {
    const u = await newUser();
    await ok(deposit(u, "USDC", 61_000_000n));
    const doc = templateById("proceeds-percent")!.build(env());
    const { strategy, last } = await activate(u, doc, 40n);
    await ok(last);
    const buy = await executeExpect(strategy, u.vault, 0, 0);
    const redeem = await executeExpect(strategy, u.vault, 1, 0);
    expect(redeem.receipt!.amountIn).toBe(buy.receipt!.amountOut);
    const recycle = await executeExpect(strategy, u.vault, 2, 0);
    expect(recycle.receipt!.amount).toBe((redeem.receipt!.amountOut * 2500n) / 10_000n);
  });

  it("attestations: threshold, distinct signers, domain, expiry, replay, dispute and adjudication", T, async () => {
    const key = "data-center";
    expect((await attest(key, 1, { signers: [attestors[0]!] })).error).toBe("AttestationInvalid");
    expect((await attest(key, 1, { signers: [attestors[0]!, attestors[0]!] })).error).toBe("AttestationInvalid");
    expect((await attest(key, 1, { signers: [attestors[0]!, Keypair.generate()] })).error).toBe("AttestationInvalid");
    expect((await attest(key, 1, { domain: ADJUDICATE_DOMAIN })).error).toBe("AttestationInvalid");
    expect((await attest(key, 1, { expiresAt: Math.floor(Date.now() / 1000) - 30 })).error).toBe("AttestationExpired");
    const n = ++nonce;
    await ok(attest(key, 1, { nonce: n }), "valid attestation");
    expect((await client.event(new PublicKey(b.events[key]!.address))).status).toBe(1);
    expect((await attest(key, 1, { nonce: n, payer: keeper })).error).toBe("AttestationReplay");
    await ok(attest(key, 0), "conflicting attestation within the window");
    const ev = new PublicKey(b.events[key]!.address);
    expect((await client.event(ev)).status).toBe(2);
    const adj = async (signers: Keypair[]) => {
      const e = await client.event(ev);
      const an = ++nonce;
      const exp = Math.floor(Date.now() / 1000) + 600;
      const msg = attestationMessage({ programId: client.ids.vault, event: ev, ruleHash: e.ruleHash, outcome: 1, observedAt: 0, nonce: an, expiresAt: exp }, ADJUDICATE_DOMAIN);
      return client.send([...ed25519Instructions(msg, signers.map((k) => k.secretKey)), client.vaultIx.adjudicate(ev, attestorSet, 1, an, exp)], [admin]);
    };
    expect((await adj(attestors.slice(0, 2))).error).toBe("AttestationInvalid");
    await ok(adj(attestors), "adjudicate 3 of 3");
    const fin = await client.event(ev);
    expect([fin.status, fin.outcome]).toEqual([3, 1]);
  });

  it("objective balance-threshold event: below threshold refused, then YES once the watched account holds 50,000 USDC", T, async () => {
    const e = b.events["grants-escrow"]!;
    const ev = new PublicKey(e.address);
    const watched = new PublicKey(b.watched["fern-grants-escrow"]!.address);
    expect((await client.send([client.vaultIx.observeBalance(ev, watched)], [keeper])).error).toBe("ThresholdNotMet");
    await mintTo(conn, admin, mint("USDC"), watched, admin, 50_000_000_000n, [], { commitment: "confirmed" }, TOKEN_PROGRAM_ID);
    await ok(client.send([client.vaultIx.observeBalance(ev, watched)], [keeper]), "observe");
    const after = await client.event(ev);
    expect([after.status, after.outcome]).toEqual([3, 1]);
  });

  it("agent session key: in-policy plan activates, out-of-policy plans and withdrawals are refused, kill switch voids it", T, async () => {
    const u = await newUser();
    await ok(deposit(u, "USDC", 500_000_000n));
    const session = Keypair.generate();
    await airdrop(session.publicKey, 2);
    const maybePool = new PublicKey(b.pools["USDC-MAYBE"]!.address);
    const { policy, ix } = client.vaultIx.createPolicy(u.user.publicKey, u.vault, session.publicKey, {
      mints: [mint("USDC"), mint("MAYBE")],
      maxTotal: [200_000_000n, 0n],
      maxPerAction: [100_000_000n, 0n],
      routes: [maybePool],
      recipients: [],
      maxFeeBps: 30,
      expiresAt: Math.floor(Date.now() / 1000) + 60 * 86_400,
      canCreate: true,
    });
    await ok(client.send([ix], [u.user]), "create_policy");
    const good = await activate(u, templateById("yes-buys-token")!.build(env()), 50n, session, policy);
    await ok(good.last, "agent activation within policy");
    expect((await client.policy(policy)).spent[0]).toBe(100_000_000n);
    const tooBig = applyOp(templateById("yes-buys-token")!.build(env()), { op: "setAllocationAmount", allocationId: "main", amount: "150000000" });
    const big = await activate(u, applyOp(tooBig, { op: "setActionAmount", actionId: "buy", amount: { kind: "fixed", amount: "150000000" } }), 51n, session, policy);
    expect(big.last.error).toBe("PolicyViolation");
    const otherRoute = await activate(u, templateById("yes-a-no-b")!.build(env()), 52n, session, policy);
    expect(otherRoute.last.error).toBe("PolicyViolation");
    const vAcc = await client.vault(u.vault);
    const e = vAcc.balances.find((x) => x.mint.equals(mint("USDC")))!;
    const wd = await client.send([client.vaultIx.withdraw(session.publicKey, u.vault, mint("USDC"), e.tokenAccount, u.wallet.USDC!, TOKEN_PROGRAM_ID, 1n)], [session]);
    expect(wd.error).toBe("NotOwner");
    await ok(client.send([client.vaultIx.killSwitch(u.user.publicKey, u.vault)], [u.user]), "kill switch");
    const after = await activate(u, templateById("yes-buys-token")!.build(env()), 53n, session, policy);
    expect(after.results[0]!.error).toBe("PolicyRevoked");
  });

  it("emergency pause blocks execution but never withdrawals or cancellation", T, async () => {
    const u = await newUser();
    await ok(deposit(u, "USDC", 150_000_000n));
    const { strategy, last } = await activate(u, templateById("yes-buys-token")!.build(env()), 60n);
    await ok(last);
    await ok(client.send([client.vaultIx.setPaused(admin.publicKey, true)], [admin]), "pause");
    try {
      await executeExpect(strategy, u.vault, 0, 0, { expectError: "ExecutionPaused" });
      const e = (await client.vault(u.vault)).balances.find((x) => x.mint.equals(mint("USDC")))!;
      await ok(client.send([client.vaultIx.withdraw(u.user.publicKey, u.vault, mint("USDC"), e.tokenAccount, u.wallet.USDC!, TOKEN_PROGRAM_ID, 50_000_000n)], [u.user]), "withdraw while paused");
      await ok(client.send([client.vaultIx.cancelStrategy(u.user.publicKey, u.vault, strategy)], [u.user]), "cancel while paused");
    } finally {
      await ok(client.send([client.vaultIx.setPaused(admin.publicKey, false)], [admin]), "unpause");
    }
  });

  it("Token-2022: transfer-fee mint is refused, metadata-only Pump-style mint is listed", T, async () => {
    expect(b.assets.TAXED!.listed).toBe(false);
    expect(b.assets.MAYBE!.listed).toBe(true);
    const r = await client.send([client.vaultIx.setAsset(admin.publicKey, mint("TAXED"), ata(admin.publicKey, mint("TAXED"), tp("TAXED")), true)], [admin]);
    expect(r.error).toBe("UnsupportedTokenExtension");
  });

  it("LAST: disabling development attestors is one-way and rejects dev sets", T, async () => {
    await ok(client.send([client.vaultIx.disableDevAttestors(admin.publicKey)], [admin]), "disable");
    expect((await client.config()).allowDevAttestors).toBe(false);
    expect((await attest("harbor-bridge", 1)).error).toBe("DevAttestorForbidden");
    const r = await client.send([client.vaultIx.initAttestorSet(admin.publicKey, 99n, attestors.map((k) => k.publicKey), 2, 3, 5, 60, true)], [admin]);
    expect(r.error).toBe("DevAttestorForbidden");
  });
});
