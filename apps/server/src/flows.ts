import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, Message, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { reservationByMint, decodePlan, type TxState } from "@maybe/core";
import { fmtUnits, type TxRecord } from "@maybe/api";
import { repoRoot, type VaultEvent } from "@maybe/sdk";
import { newId, type App } from "./app.ts";
import { Chain, ChainError, type TxPlan } from "./chain.ts";
import type pg from "pg";
import { withTx } from "./db.ts";
import { log, shortAddr } from "./log.ts";
import {
  Conflict,
  INTENT_LEASE_SECONDS,
  createIntent,
  getIntent,
  getStrategy,
  insertTx,
  intentTxs,
  leaseIntent,
  lockStrategy,
  logActivity,
  markEffect,
  markSubmitted,
  releaseIntent,
  setIntent,
  setTx,
  strategyProjections,
  txRecord,
  updateStrategy,
  voidIntent,
  type IntentKind,
  type IntentRow,
  type TxRow,
} from "./store.ts";

/**
 * Intents: a user request turned into exact transaction bytes. The wallet
 * signs those bytes; the server attaches the signatures, sends the
 * transactions strictly in order, and applies each one's effects exactly once
 * after it confirms. Everything is persisted, so a restarted process resumes
 * an intent where it stopped; re-sending identical signed bytes can't apply
 * twice because the signature is the transaction's identity.
 */

export class BadRequest extends Error {
  readonly status = 400;
}

export interface BuiltIntent {
  intent: string;
  labels: string[];
  txs: string[];
}

export async function buildIntent(
  app: App,
  o: { kind: IntentKind; owner: string; actor: string; key: string; strategyId?: string; payload: Record<string, unknown>; plans: TxPlan[] },
  /** runs inside the transaction that creates the intent, before it's created; throw to refuse, and see the new id after */
  guard?: { before?: (c: pg.PoolClient) => Promise<void>; after?: (c: pg.PoolClient, intentId: string) => Promise<void> },
): Promise<BuiltIntent> {
  const compiled = await app.chain.compile(o.plans, new PublicKey(o.actor));
  const id = newId("int");
  const result = await withTx(app.db, async (c) => {
    await guard?.before?.(c);
    const { intent, created } = await createIntent(c, { id, key: `${o.owner}:${o.key}`, kind: o.kind, actor: o.actor, owner: o.owner, strategyId: o.strategyId ?? null, payload: o.payload });
    if (!created) return intent;
    for (const [seq, t] of compiled.entries()) await insertTx(c, { id: newId("tx"), intentId: id, seq, label: t.label, ...(t.effect ? { effect: t.effect } : {}), message: t.message, blockhash: t.blockhash, lastValidBlockHeight: t.lastValidBlockHeight });
    await guard?.after?.(c, id);
    return intent;
  });
  const txs = await intentTxs(app.db, result.id);
  return { intent: result.id, labels: txs.map((t) => t.label), txs: txs.map((t) => Buffer.from(JSON.stringify({ message: t.message.toString("base64") })).toString("base64")) };
}

const STALE = "This future changed after these transactions were prepared. Review it again before signing.";

/** The user's wallet signed; attach, persist, and start sending. Idempotent for retries. */
export async function submitSigned(app: App, user: string, intentId: string, signed: string[]): Promise<TxRecord[]> {
  const intent = await getIntent(app.db, intentId);
  if (!intent || intent.owner !== user) throw new BadRequest("Unknown request.");
  const txs = await intentTxs(app.db, intentId);
  // voided before anything was signed (the future changed, or a newer request replaced it): say why
  if (intent.state === "FAILED" && txs.every((t) => !t.signature)) throw new Conflict(intent.error ?? STALE);
  if (intent.state !== "BUILT") return txs.map(txRecord);
  if (signed.length !== txs.length) throw new BadRequest(`Expected ${txs.length} signed transaction(s).`);
  const attached = txs.map((t, i) => {
    let parsed: { signer: string; signature: string };
    try {
      parsed = JSON.parse(signed[i]!) as { signer: string; signature: string };
    } catch {
      throw new BadRequest("Malformed signature.");
    }
    if (parsed.signer !== intent.actor) throw new BadRequest("Signed by the wrong key.");
    try {
      return { t, raw: Chain.attach(t.message, parsed.signer, parsed.signature), signature: parsed.signature };
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
  });
  const started = await withTx(app.db, async (c) => {
    // An authorization is only valid for the plan it was built from, while that plan is still the one
    // waiting for a signature. The strategy row is locked so edits, deletes and new authorizations
    // serialize with this check.
    if (intent.kind === "authorize" && intent.strategyId) {
      const s = await lockStrategy(c, intent.strategyId);
      const planHash = intent.payload.planHash as string | undefined;
      if (!s || s.status !== "AWAITING_SIGNATURE" || (planHash && s.planHash !== planHash)) {
        await voidIntent(c, intentId, STALE);
        return "stale" as const;
      }
    }
    const r = await c.query(`UPDATE intents SET state = 'SUBMITTING', updated_at = now() WHERE id = $1 AND state = 'BUILT'`, [intentId]);
    if (!r.rowCount) return false;
    for (const a of attached) await setTx(c, a.t.id, { state: "SIGNED", signedTx: a.raw, signature: a.signature });
    await onSigned(c, intent);
    return true;
  });
  if (started === "stale") throw new Conflict(STALE);
  if (started) {
    await app.publish(["strategies", "portfolio", "activity"]);
    void runIntent(app, intentId).catch((e) => log.error({ intent: intentId, err: (e as Error).message }, "intent runner stopped; it resumes from the database"));
  }
  return (await intentTxs(app.db, intentId)).map(txRecord);
}

/** Server-held signer (agent session key on localnet): sign the intent's messages directly. */
export async function signAndSubmitAs(app: App, intentId: string, signer: Keypair): Promise<TxRecord[]> {
  const txs = await intentTxs(app.db, intentId);
  const intent = (await getIntent(app.db, intentId))!;
  const signed = txs.map((t) => {
    const tx = Transaction.populate(Message.from(t.message));
    tx.sign(signer);
    return JSON.stringify({ signer: signer.publicKey.toBase58(), signature: bs58.encode(tx.signature!) });
  });
  return submitSigned(app, intent.owner, intentId, signed);
}

async function onSigned(c: pg.PoolClient, intent: IntentRow): Promise<void> {
  if (intent.kind === "authorize" && intent.strategyId) await updateStrategy(c, intent.strategyId, { status: "UPLOADING", lastError: null });
}

const HEARTBEAT_MS = Math.max(1000, Math.floor((INTENT_LEASE_SECONDS * 1000) / 6));

/**
 * Send an intent's transactions in order. Safe to call from several places at once: each call
 * is its own lease holder, the lease is renewed while a confirmation is awaited, and a call that
 * loses its lease stops without writing anything — the new holder re-derives every outcome from
 * the chain (a signature that already landed is recognised, never re-sent as new).
 */
export async function runIntent(app: App, intentId: string): Promise<void> {
  const holder = `${app.runner}/${newId("run")}`;
  if (!(await leaseIntent(app.db, intentId, holder))) return;
  let lost = false;
  const renew = async (): Promise<boolean> => {
    if (lost) return false;
    const ok = await leaseIntent(app.db, intentId, holder).catch(() => true); // a DB blip isn't a lost lease; the next beat decides
    if (!ok) {
      lost = true;
      log.warn({ intent: intentId }, "lost the lease on an intent; another runner continues it");
    }
    return ok;
  };
  let beat: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    beat = renew();
  }, HEARTBEAT_MS);
  try {
    const intent = (await getIntent(app.db, intentId))!;
    const txs = await intentTxs(app.db, intentId);
    for (const t of txs) {
      if (!(await renew())) return;
      if (t.state === "CONFIRMED" || t.state === "FINALIZED") {
        await applyEffect(app, intent, t, txs, null);
        continue;
      }
      if (t.state === "FAILED" || t.state === "EXPIRED") return await failRest(app, intent, txs, t, t.error ?? "An earlier step didn't land.");
      if (process.env.MAYBE_CRASH_BEFORE_SEND === intent.kind) {
        log.warn({ intent: intentId }, "MAYBE_CRASH_BEFORE_SEND set: exiting before sending (test hook)");
        process.exit(86);
      }
      const out = await app.chain.sendSigned(t.signedTx!, t.lastValidBlockHeight, {
        mayHaveLanded: t.state === "SUBMITTED",
        beforeFirstSend: async () => {
          await markSubmitted(app.db, t.id, t.signature!);
          await app.publish(["strategies", "portfolio"]);
        },
        keepGoing: () => !lost,
      });
      if (out.aborted) return;
      if (process.env.MAYBE_CRASH_AFTER_SEND === intent.kind && out.ok) {
        log.warn({ intent: intentId, signature: out.signature }, "MAYBE_CRASH_AFTER_SEND set: exiting after the transaction landed, before recording it (test hook)");
        process.exit(87);
      }
      if (out.ok) {
        // a confirmed signature is a fact, whoever holds the lease; the effect applies once either way
        await setTx(app.db, t.id, { state: "CONFIRMED", ...(out.slot ? { slot: out.slot } : {}) });
        await applyEffect(app, intent, { ...t, state: "CONFIRMED", ...(out.slot ? { slot: out.slot } : {}) }, txs, out.logsMissing ? null : out.events);
        continue;
      }
      if (lost) return; // a failure is only recorded by the current holder
      await setTx(app.db, t.id, { state: out.expired ? "EXPIRED" : "FAILED", error: out.error ?? "Rejected" });
      return await failRest(app, intent, txs, t, out.error ?? "Rejected");
    }
    if (lost) return;
    await setIntent(app.db, intentId, "DONE");
    await app.publish(["strategies", "portfolio", "activity", "wallet", "agents"]);
  } finally {
    clearInterval(timer);
    await beat.catch(() => undefined);
    await releaseIntent(app.db, intentId, holder);
  }
}

async function failRest(app: App, intent: IntentRow, txs: TxRow[], failed: TxRow, error: string): Promise<void> {
  const p = intent.payload as Record<string, unknown>;
  // Before telling anyone "nothing was reserved", ask the chain: if the activation landed after all
  // (a confirmation that arrived late), the chain is right and this is not a failure. If the chain
  // can't be asked right now, this throws and the runner retries later rather than guess.
  const activated = intent.kind === "authorize" && typeof p.strategyAccount === "string" ? await app.chain.probeStrategyAt(new PublicKey(p.strategyAccount), p.planHash as string | undefined) : null;
  const now = await app.now();
  await withTx(app.db, async (c) => {
    for (const t of txs) if (t.seq > failed.seq && (t.state === "SIGNED" || t.state === "BUILT")) await setTx(c, t.id, { state: "FAILED", error: "Not sent: an earlier step didn't land." });
    await setIntent(c, intent.id, "FAILED", error);
    if (await markEffect(c, intent.id, -1)) await recordFailure(app, c, intent, failed, error, now, activated);
  });
  if (activated?.activated) await app.indexer.syncVault(intent.owner).catch((e) => log.warn({ err: (e as Error).message }, "vault sync after a late activation failed; the indexer catches up"));
  await app.publish(["strategies", "portfolio", "activity", "wallet", "agents"]);
}

// ───────────────────────────────────────── effects (exactly once per confirmed transaction)

/**
 * The database part of an effect commits in the same transaction that marks it applied, so a crash
 * either loses both (and the next runner applies it) or keeps both. Chain reads that refresh
 * projections run afterwards; they're idempotent and the indexer repeats them on its own anyway.
 */
async function applyEffect(app: App, intent: IntentRow, t: TxRow, all: TxRow[], events: VaultEvent[] | null): Promise<void> {
  const now = await app.now();
  const applied = await withTx(app.db, async (c) => {
    if (!(await markEffect(c, intent.id, t.seq))) return false;
    await recordEffect(app, c, intent, t, all, now);
    return true;
  });
  if (!applied) return;
  try {
    await refreshAfter(app, intent, t, all, events);
  } catch (e) {
    log.warn({ intent: intent.id, seq: t.seq, err: (e as Error).message }, "projection refresh after an effect failed; the indexer catches up");
  }
  await app.publish(["strategies", "portfolio", "activity", "wallet", "agents", "ops"]);
}

async function recordEffect(app: App, c: pg.PoolClient, intent: IntentRow, t: TxRow, all: TxRow[], now: number): Promise<void> {
  const last = t.seq === all.length - 1;
  const p = intent.payload as Record<string, unknown>;
  const fmt = (m: string, u: bigint) => fmtUnits(app.fx, m, u);
  const tx: TxRecord = txRecord({ ...t, state: "CONFIRMED" });
  switch (intent.kind) {
    case "deposit":
    case "withdraw": {
      const mint = p.mint as string;
      const units = p.units as bigint;
      await logActivity(c, intent.owner, { at: now, kind: intent.kind, title: `${intent.kind === "deposit" ? "Deposited" : "Withdrew"} ${fmt(mint, units)}`, actor: "you", amounts: [{ mint, units, dir: intent.kind === "deposit" ? "in" : "out" }], tx }, `tx:${t.signature}`);
      return;
    }
    case "authorize": {
      const id = intent.strategyId!;
      // the account exists on-chain with this plan's hash from here on: the version is fixed
      if (t.seq === ((p.accountSeq as number | undefined) ?? 0) && p.strategyAccount) await updateStrategy(c, id, { strategyAccount: p.strategyAccount as string });
      if (!last) {
        if (t.seq === all.length - 2) await updateStrategy(c, id, { status: "ACTIVATING" });
        return;
      }
      const s = await getStrategy(c, id);
      await updateStrategy(c, id, { status: "ACTIVE", signedAt: now, lastError: null, ...(p.strategyAccount ? { strategyAccount: p.strategyAccount as string } : {}) });
      if (p.supersedes) await updateStrategy(c, p.supersedes as string, { status: "SUPERSEDED" });
      const per = s?.planBytes ? reservationByMint(decodePlan(s.planBytes)) : {};
      const via = p.policyLabel ? `Funded by an agent session key under “${p.policyLabel}”; the program checked the policy's limits. ` : "";
      await logActivity(
        c,
        intent.owner,
        { at: now, kind: "activate", title: `Authorized “${s?.title ?? "future"}”`, detail: `${via}Reserved ${Object.entries(per).map(([m, v]) => fmt(m, v)).join(" + ")}. Plan ${(s?.planHash ?? "").slice(0, 12)}…`, actor: p.policyLabel ? "agent" : "you", strategyId: id, amounts: Object.entries(per).map(([mint, units]) => ({ mint, units, dir: "move" as const })), tx },
        `tx:${t.signature}`,
      );
      return;
    }
    case "pause": {
      const paused = p.paused as boolean;
      await updateStrategy(c, intent.strategyId!, { status: paused ? "PAUSED" : "ACTIVE" });
      const s = await getStrategy(c, intent.strategyId!);
      await logActivity(c, intent.owner, { at: now, kind: "pause", title: `${paused ? "Paused" : "Resumed"} “${s?.title}”`, actor: "you", strategyId: intent.strategyId!, tx }, `tx:${t.signature}`);
      return;
    }
    case "cancel":
      await updateStrategy(c, intent.strategyId!, { status: "CANCELLED" });
      return;
    case "policy-create":
      await logActivity(c, intent.owner, { at: now, kind: "policy", title: `Granted “${p.label as string}”`, detail: "An agent session key may create and fund futures within these limits until it expires or you revoke it. It can never withdraw.", actor: "you", tx }, `tx:${t.signature}`);
      return;
    case "policy-revoke":
      await logActivity(c, intent.owner, { at: now, kind: "policy", title: `Revoked “${p.label as string}”`, actor: "you", tx }, `tx:${t.signature}`);
      return;
    case "kill-switch":
      await logActivity(c, intent.owner, { at: now, kind: "policy", title: "Kill switch: all agent authority revoked", detail: "Every policy for this vault is void. Withdrawals and refunds are unaffected.", actor: "you", tx }, `tx:${t.signature}`);
      return;
  }
}

/** Projection refreshes after an effect (chain reads; idempotent). */
async function refreshAfter(app: App, intent: IntentRow, t: TxRow, all: TxRow[], events: VaultEvent[] | null): Promise<void> {
  const last = t.seq === all.length - 1;
  switch (intent.kind) {
    case "authorize":
      if (last) await app.indexer.syncVault(intent.owner);
      return;
    case "cancel": {
      await app.indexer.syncVault(intent.owner);
      const s = await getStrategy(app.db, intent.strategyId!);
      const evs = events ?? (t.signature ? await app.indexer.txEvents(t.signature) : []);
      const state = s?.strategyAccount ? (await strategyProjections(app.db, { accounts: [s.strategyAccount] })).get(s.strategyAccount) : undefined;
      if (state && s) for (const e of evs) await app.indexer.applyEvent(e, t.signature!, t.slot ?? 0, state, s);
      return;
    }
    case "policy-create":
    case "policy-revoke":
      await app.indexer.syncPolicies(intent.owner);
      return;
    default:
      await app.indexer.syncVault(intent.owner);
  }
}

async function recordFailure(app: App, c: pg.PoolClient, intent: IntentRow, t: TxRow, error: string, now: number, chainSays: { activated: boolean } | null): Promise<void> {
  const p = intent.payload as Record<string, unknown>;
  const tx = txRecord({ ...t, state: t.state as TxState });
  if (intent.kind === "authorize" && intent.strategyId) {
    const s = await getStrategy(c, intent.strategyId);
    if (chainSays?.activated) {
      // the activation is on-chain: record the account and let the vault sync set the status from the chain
      await updateStrategy(c, intent.strategyId, { strategyAccount: p.strategyAccount as string, lastError: null });
      await logActivity(c, intent.owner, { at: now, kind: "activate", title: `Authorized “${s?.title ?? "future"}”`, detail: "Its confirmation arrived late; the program reserved the funds when the activation landed.", actor: p.policyLabel ? "agent" : "you", strategyId: intent.strategyId }, `late:${intent.id}`);
      return;
    }
    await updateStrategy(c, intent.strategyId, { status: "ACTIVATION_FAILED", lastError: error });
    await logActivity(c, intent.owner, { at: now, kind: "failure", title: `Authorization of “${s?.title}” didn't complete`, detail: `${t.label}: ${error} No funds were reserved.`, actor: "system", strategyId: intent.strategyId, tx }, `fail:${intent.id}`);
    return;
  }
  const what: Record<IntentKind, string> = {
    deposit: "Deposit",
    withdraw: "Withdrawal",
    authorize: "Authorization",
    pause: "Pause",
    cancel: "Cancel",
    "policy-create": `Grant of “${String(p.label ?? "policy")}”`,
    "policy-revoke": "Revoke",
    "kill-switch": "Kill switch",
  };
  await logActivity(c, intent.owner, { at: now, kind: "failure", title: `${what[intent.kind]} didn't land`, detail: `${error} Nothing changed.`, actor: "system", ...(intent.strategyId ? { strategyId: intent.strategyId } : {}), tx }, `fail:${intent.id}`);
}

// ───────────────────────────────────────── localnet session-key keystore

/**
 * Agent session keys on localnet live in .localnet/session-keys (gitignored,
 * mode 600). A production deployment must hold them in a KMS/HSM instead;
 * the server refuses to create server-held keys outside localnet.
 */
export class LocalKeystore {
  private readonly dir = join(repoRoot(), ".localnet", "session-keys");

  constructor(private readonly app: App) {
    if (app.cfg.MAYBE_MODE !== "localnet") throw new ChainError("Server-held agent session keys are only available on localnet.");
  }

  create(): Keypair {
    mkdirSync(this.dir, { recursive: true });
    const k = this.app.chain.newSessionKey();
    const path = join(this.dir, `${k.publicKey.toBase58()}.json`);
    writeFileSync(path, JSON.stringify(Array.from(k.secretKey)));
    chmodSync(path, 0o600);
    log.info({ sessionKey: shortAddr(k.publicKey.toBase58()) }, "created localnet agent session key");
    return k;
  }

  load(pub: string): Keypair {
    const path = join(this.dir, `${pub}.json`);
    if (!existsSync(path)) throw new ChainError("This policy's session key isn't held by this server.");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
  }
}
