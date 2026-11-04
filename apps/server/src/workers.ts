import { PublicKey } from "@solana/web3.js";
import { actionReadiness, allActionsTerminal, checkVaultInvariants, guardTimes, holdingsByMint, type StrategyState } from "@maybe/core";
import { decodeAttestorSet, toEventView, toStrategyState, toVaultState, vaultErrorName } from "@maybe/sdk";
import type { App } from "./app.ts";
import { runIntent } from "./flows.ts";
import { logIndexerError } from "./indexer.ts";
import { claim, defer, enqueue, fail, heartbeat, succeed, type Job } from "./jobs.ts";
import { log, shortAddr } from "./log.ts";
import { abandonedIntents, allVaults, getStrategyByAccount, kvSet, logActivity, openTxs, recordReconciliation, setTx, updateStrategy } from "./store.ts";
import { chainContext } from "./views.ts";

/**
 * Background work: the keeper (a permissionless crank — anyone could run it,
 * and the program decides), the settlement watcher, transaction recovery and
 * reconciliation. Everything is driven from durable jobs and re-reads chain
 * state before acting.
 */

const NOT_READY_RETRY_SECONDS = 3;
/** A step that ran out of attempts but can still execute is tried again after this pause (prices and RPCs recover). */
const REVIVE_DEAD_AFTER_SECONDS = Number(process.env.MAYBE_JOB_REVIVE_SECONDS ?? 300);
/** An unexpected exception (RPC or database trouble, not a program error) retries after this, without spending an attempt. */
const INFRA_RETRY_SECONDS = 15;
/** errors that mean "this run already happened or can never happen": the job is finished */
const TERMINAL = new Set(["ActionComplete", "BranchLost", "StrategyClosed", "RunOutOfOrder", "NotActive", "DeadlinePassed"]);
/** not yet: the guard, delay or schedule isn't satisfied on-chain (projection was ahead of the chain) */
const NOT_YET = new Set(["GuardPending", "DelayPending", "RunNotDue", "StrategyPaused", "ExecutionPaused"]);

export class Keeper {
  ticks = 0;
  constructor(private readonly app: App) {}

  /** Find executable steps and due closes; enqueue one job per (strategy, action, run). */
  async scan(): Promise<number> {
    const ctx = await chainContext(this.app);
    let n = 0;
    for (const s of Object.values(ctx.strategies)) {
      if (s.status !== "ACTIVE" && s.status !== "PAUSED") continue;
      if (ctx.now >= s.plan.expiresAt) {
        if (await enqueue(this.app.db, "close", `close:${s.address}:expire`, { strategy: s.address, vault: s.vault, mode: "EXPIRE" }, { reviveDeadAfterSeconds: REVIVE_DEAD_AFTER_SECONDS })) n++;
        continue;
      }
      if (s.status !== "ACTIVE" || ctx.executionPaused) continue;
      const times = guardTimes(s, ctx);
      for (let i = 0; i < s.plan.actions.length; i++) {
        const r = actionReadiness(s, i, ctx, times);
        if (r.state === "executable" && (await enqueue(this.app.db, "execute", `execute:${s.address}:${i}:${r.run}`, { strategy: s.address, vault: s.vault, action: i, run: r.run }, { reviveDeadAfterSeconds: REVIVE_DEAD_AFTER_SECONDS }))) n++;
      }
      if (allActionsTerminal(s, ctx) && (await enqueue(this.app.db, "close", `close:${s.address}:complete`, { strategy: s.address, vault: s.vault, mode: "COMPLETE" }, { reviveDeadAfterSeconds: REVIVE_DEAD_AFTER_SECONDS }))) n++;
    }
    this.ticks++;
    await kvSet(this.app.db, "keeper", { lastTickAt: ctx.now, ticks: this.ticks, at: Math.floor(Date.now() / 1000) });
    return n;
  }

  /** Fresh chain read → readiness → execute. Never trusts the projection for spending decisions. */
  async execute(job: Job, worker: string): Promise<void> {
    const { strategy, vault, action, run } = job.payload as { strategy: string; vault: string; action: number; run: number };
    const db = this.app.db;
    const key = new PublicKey(strategy);
    const acct = await this.app.chain.maybeStrategy(key);
    const rt = acct ? toStrategyState(key, acct) : null;
    if (!rt || (rt.status !== "ACTIVE" && rt.status !== "PAUSED")) return void (await succeed(db, job, worker));
    if (rt.actions[action]!.runsDone > run) {
      // it already happened (perhaps by us before a crash): record it, never repeat it
      await this.app.indexer.syncTxEvents(rt, await getStrategyByAccount(db, strategy));
      return void (await succeed(db, job, worker));
    }
    const ctx = await this.freshContext(rt);
    const r = actionReadiness(rt, action, ctx);
    if (r.state === "done") return void (await succeed(db, job, worker));
    if (r.state !== "executable") return void (await defer(db, job, worker, r.state === "scheduled" ? Math.max(1, r.at - ctx.now) : NOT_READY_RETRY_SECONDS, `not ready: ${r.state}${"reason" in r ? ` (${r.reason})` : ""}`));
    if (r.run !== run) return void (await succeed(db, job, worker)); // a different run is due; the scan enqueues it
    if (process.env.MAYBE_CRASH_BEFORE_SEND === "execute") {
      log.warn({ job: job.key }, "MAYBE_CRASH_BEFORE_SEND=execute: exiting before sending (test hook)");
      process.exit(86);
    }
    const out = await this.app.chain.execute(new PublicKey(vault), key, action, run);
    if (process.env.MAYBE_CRASH_AFTER_SEND === "execute") {
      log.warn({ job: job.key, signature: out.signature }, "MAYBE_CRASH_AFTER_SEND=execute: exiting after the transaction landed, before recording it (test hook)");
      process.exit(87);
    }
    const row = await getStrategyByAccount(db, strategy);
    if (out.ok) {
      for (const e of out.events) await this.app.indexer.applyEvent(e, out.signature!, 0, rt, row);
      if (row?.lastError) await updateStrategy(db, row.id, { lastError: null });
      await this.app.indexer.syncVault(rt.owner);
      await succeed(db, job, worker);
      await this.app.publish(["strategies", "portfolio", "activity", "ops"]);
      log.info({ strategy: shortAddr(strategy), action, run, signature: out.signature }, "executed");
      return;
    }
    const name = out.code !== undefined ? vaultErrorName(out.code) : undefined;
    if (name && TERMINAL.has(name)) {
      await this.app.indexer.syncTxEvents(rt, row);
      return void (await succeed(db, job, worker));
    }
    if (name && NOT_YET.has(name)) return void (await defer(db, job, worker, NOT_READY_RETRY_SECONDS, name));
    const state = await fail(db, job, worker, out.error ?? "failed", { retryable: true });
    if (row) {
      const label = row.doc.actions[action]?.label ?? `Step ${action + 1}`;
      await updateStrategy(db, row.id, { lastError: `${label}: ${out.error}` });
      await logActivity(db, row.owner, { at: ctx.now, kind: "failure", title: `${label} of “${row.doc.title}” didn't execute`, detail: `${out.error}. Nothing was spent${state === "DEAD" ? `; the keeper pauses this step and tries again in ${Math.round(REVIVE_DEAD_AFTER_SECONDS / 60)} min while it can still run.` : "; it will be retried."}`, actor: "keeper", strategyId: row.id }, `execfail:${job.key}:${job.attempts}`);
      await this.app.publish(["strategies", "activity", "ops"]);
    }
  }

  async close(job: Job, worker: string): Promise<void> {
    const { strategy, vault, mode } = job.payload as { strategy: string; vault: string; mode: "EXPIRE" | "COMPLETE" };
    const db = this.app.db;
    const key = new PublicKey(strategy);
    const acct = await this.app.chain.maybeStrategy(key);
    const rt = acct ? toStrategyState(key, acct) : null;
    if (!rt) return void (await succeed(db, job, worker));
    const row = await getStrategyByAccount(db, strategy);
    if (rt.status !== "ACTIVE" && rt.status !== "PAUSED") {
      await this.app.indexer.syncTxEvents(rt, row);
      await this.app.indexer.syncVault(rt.owner);
      return void (await succeed(db, job, worker));
    }
    const out = mode === "EXPIRE" ? await this.app.chain.closeExpired(new PublicKey(vault), key) : await this.app.chain.closeCompleted(new PublicKey(vault), key);
    if (out.ok) {
      for (const e of out.events) await this.app.indexer.applyEvent(e, out.signature!, 0, rt, row);
      await this.app.indexer.syncVault(rt.owner);
      await succeed(db, job, worker);
      await this.app.publish(["strategies", "portfolio", "activity", "ops"]);
      return;
    }
    const name = out.code !== undefined ? vaultErrorName(out.code) : undefined;
    if (name === "StrategyClosed") return void (await succeed(db, job, worker));
    if (name === "NotExpired" || name === "NotComplete") return void (await defer(db, job, worker, NOT_READY_RETRY_SECONDS, name));
    await fail(db, job, worker, out.error ?? "close failed", { retryable: true });
  }

  /** Chain context from fresh reads of everything this strategy depends on. */
  private async freshContext(rt: StrategyState) {
    const ctx = await chainContext(this.app);
    const evs = await this.app.chain.events(rt.plan.events);
    for (const [k, v] of evs) ctx.events[k] = toEventView(v);
    ctx.now = await this.app.chain.clock();
    ctx.executionPaused = (await this.app.chain.config()).pausedExecution;
    return ctx;
  }
}

/** Objective events and finality cranks (all permissionless; the program checks everything). */
export class SettlementWatcher {
  constructor(private readonly app: App) {}

  async tick(): Promise<void> {
    const { chain, book, db } = this.app;
    const now = await chain.clock();
    const accts = await chain.events(Object.values(book.events).map((e) => e.address));
    for (const [address, a] of accts) {
      const view = toEventView(a);
      if (view.adapter === "BALANCE" && view.status === "OPEN" && now <= a.deadline) {
        const w = Object.values(book.watched).find((x) => x.address === a.binding.toBase58());
        if (!w) continue;
        const [bal] = await chain.tokenBalances([new PublicKey(w.address)]);
        if (bal! >= a.threshold) await enqueue(db, "observe", `observe:${address}:${Math.floor(now / 30)}`, { event: address, watched: w.address });
      } else if (view.status === "PENDING" && view.finalAt !== null && view.finalAt <= now) {
        await enqueue(db, "finalize", `finalize:${address}:${view.finalAt}`, { event: address });
      } else if (view.status === "DISPUTED") {
        const set = decodeAttestorSet((await chain.client.account(a.binding)).data);
        if (a.disputedAt + set.disputeTimeoutSeconds <= now) await enqueue(db, "void-disputed", `void:${address}:${a.disputedAt}`, { event: address, set: a.binding.toBase58() });
      }
    }
  }

  async handle(job: Job, worker: string): Promise<void> {
    const { chain, db } = this.app;
    const p = job.payload as { event: string; watched?: string; set?: string };
    const out =
      job.kind === "observe"
        ? await chain.observeBalance(new PublicKey(p.event), new PublicKey(p.watched!))
        : job.kind === "finalize"
          ? await chain.finalizeEvent(new PublicKey(p.event))
          : await chain.sendAs(chain.keeper, [chain.client.vaultIx.voidDisputed(new PublicKey(p.event), new PublicKey(p.set!))]);
    if (out.ok || /InvalidEventState|ThresholdNotMet/.test(out.error ?? "")) {
      await succeed(db, job, worker);
      await this.app.indexer.syncBasics();
      return;
    }
    await fail(db, job, worker, out.error ?? "failed", { retryable: true });
  }
}

/** Ledger reconciliation against actual token balances, per vault. */
export class Reconciler {
  constructor(private readonly app: App) {}

  async tick(): Promise<void> {
    const { chain, db } = this.app;
    for (const { vault, owner } of await allVaults(db)) {
      const key = new PublicKey(vault);
      const v = await chain.maybeVault(key);
      if (!v) continue;
      const tokens = await chain.tokenBalances(v.balances.map((b) => b.tokenAccount));
      const tb: Record<string, bigint> = {};
      v.balances.forEach((b, i) => (tb[b.mint.toBase58()] = tokens[i]!));
      const active = (await chain.strategiesOf(key)).map(({ address, account }) => toStrategyState(address, account)).filter((s): s is StrategyState => !!s && (s.status === "ACTIVE" || s.status === "PAUSED"));
      const issues = checkVaultInvariants(toVaultState(key, v, tb), holdingsByMint(active));
      await recordReconciliation(db, `vault ${shortAddr(vault)} (${shortAddr(owner)})`, issues.length === 0, issues.length ? issues.map((x) => x.message).join("; ") : `token balances = available + reserved; reserved = Σ holdings of ${active.length} active future(s)`);
      if (issues.length) log.error({ vault, issues }, "RECONCILIATION MISMATCH");
    }
    await this.app.publish(["ops"]);
  }
}

/** Resume intents whose runner died; mark confirmed transactions finalized. */
export class TxWatch {
  constructor(private readonly app: App) {}

  async tick(): Promise<void> {
    for (const id of await abandonedIntents(this.app.db)) await runIntent(this.app, id);
    for (const t of await openTxs(this.app.db)) {
      if (!t.signature) continue;
      const st = await this.app.chain.signatureStatus(t.signature).catch(() => null);
      if (st?.confirmationStatus === "finalized") await setTx(this.app.db, t.id, { state: "FINALIZED" });
    }
  }
}

export class Worker {
  readonly keeper: Keeper;
  readonly settlement: SettlementWatcher;
  readonly reconciler: Reconciler;
  readonly txwatch: TxWatch;
  private stopped = false;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly leaseSeconds = Number(process.env.MAYBE_JOB_LEASE_SECONDS ?? 30);

  constructor(
    private readonly app: App,
    private readonly id: string,
  ) {
    this.keeper = new Keeper(app);
    this.settlement = new SettlementWatcher(app);
    this.reconciler = new Reconciler(app);
    this.txwatch = new TxWatch(app);
  }

  private every(ms: number, name: string, f: () => Promise<unknown>) {
    let busy = false;
    const run = async () => {
      if (busy || this.stopped) return;
      busy = true;
      try {
        await f();
      } catch (e) {
        logIndexerError(name, e);
      } finally {
        busy = false;
      }
    };
    void run();
    this.timers.push(setInterval(run, ms));
  }

  start(): void {
    this.every(1500, "basics", () => this.app.indexer.syncBasics());
    this.every(2500, "vaults", async () => {
      for (const v of await allVaults(this.app.db)) await this.app.indexer.syncVault(v.owner);
    });
    this.every(1500, "keeper", () => this.keeper.scan());
    this.every(2000, "settlement", () => this.settlement.tick());
    this.every(3000, "txwatch", () => this.txwatch.tick());
    this.every(15000, "reconcile", () => this.reconciler.tick());
    void this.loop();
  }

  /** Claim and run jobs until stopped. */
  private async loop(): Promise<void> {
    while (!this.stopped) {
      let jobs: Job[] = [];
      try {
        jobs = await claim(this.app.db, this.id, ["execute", "close", "observe", "finalize", "void-disputed"], { limit: 4, leaseSeconds: this.leaseSeconds });
      } catch (e) {
        logIndexerError("claim", e);
      }
      for (const j of jobs) await this.runJob(j);
      if (!jobs.length) await new Promise((r) => setTimeout(r, 400));
    }
  }

  async runJob(j: Job): Promise<void> {
    // keep the lease while the job waits on the chain, so a slow confirmation isn't mistaken for a dead worker
    const beat = setInterval(() => void heartbeat(this.app.db, j, this.id, this.leaseSeconds).catch(() => undefined), Math.max(500, (this.leaseSeconds * 1000) / 3));
    try {
      if (j.kind === "execute") await this.keeper.execute(j, this.id);
      else if (j.kind === "close") await this.keeper.close(j, this.id);
      else await this.settlement.handle(j, this.id);
    } catch (e) {
      // programs answer with errors in the outcome; an exception is RPC or database trouble: retry without spending an attempt
      log.warn({ job: j.key, err: (e as Error).message }, "job threw; retrying later");
      await defer(this.app.db, j, this.id, INFRA_RETRY_SECONDS, `retrying after an infrastructure error: ${(e as Error).message}`.slice(0, 500)).catch(() => undefined);
    } finally {
      clearInterval(beat);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
  }
}
