import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  checkPolicyForPlan,
  decodePlan,
  newVersion,
  planHash,
  reservationByMint,
  sha256Bytes,
  compileStrategy,
  type CapabilityPolicy,
  type Strategy,
} from "@maybe/core";
import { capabilityContext, fixtureWorld, newConversation, runLocalTurn, type AgentStrategySummary, type Conversation } from "@maybe/agent";
import {
  cloneRoomDoc,
  draftStatus,
  environmentInfo,
  fmtUnits,
  parse,
  prepareStrategy,
  roomSlug,
  sampleRooms,
  stringify,
  strategyView,
  type AgentRole,
  type AgentStep,
  type RoomRecord,
} from "@maybe/api";
import { newId, type App } from "./app.ts";
import { AuthError, createChallenge, isAddress, rateLimit, revokeSession, sessionAddress, verifyChallenge } from "./auth.ts";
import { ChainError } from "./chain.ts";
import { BadRequest, LocalKeystore, buildIntent, signAndSubmitAs, submitSigned } from "./flows.ts";
import { log, shortAddr } from "./log.ts";
import type { Hub } from "./outbox.ts";
import {
  Conflict,
  NotFound,
  audit,
  bumpCopies,
  deleteDraft,
  ensureUser,
  getSession,
  getStrategy,
  insertPolicy,
  insertRoom,
  insertRoomVersion,
  listActivity,
  listPolicies,
  listRooms,
  listSessions,
  listStrategies,
  logActivity,
  roomBySourceDoc,
  saveDraft,
  saveSession,
  updateStrategy,
  vaultProjection,
  type SessionRow,
} from "./store.ts";
import { assets, chainContext, lookupFor, market, markets, ops, policies, portfolio, records, strategyViews } from "./views.ts";

type Env = { Variables: { user: string | null } };

class Forbidden extends Error {
  readonly status = 403;
}

const json = (c: Context, body: unknown, status = 200) => c.body(stringify(body), status as 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });

async function body<T>(c: Context, schema?: z.ZodType<T>): Promise<T> {
  const text = await c.req.text();
  let v: unknown;
  try {
    v = text ? parse<unknown>(text) : {};
  } catch {
    throw new BadRequest("Malformed JSON.");
  }
  if (!schema) return v as T;
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequest(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

const zUnits = z.bigint().refine((v) => v > 0n && v < 2n ** 64n, "must be a positive u64 amount");
const zAddr = z.string().refine(isAddress, "not a Solana address");
const zDoc = z.custom<Strategy>((v) => !!v && typeof v === "object" && typeof (v as Strategy).id === "string" && Array.isArray((v as Strategy).actions), "not a strategy document");

/** u64 PDA seed for a document: its numeric nonce, else a hash of id+nonce. */
function seedFor(doc: Strategy, bump = 0n): bigint {
  const base = /^\d{1,19}$/.test(doc.nonce) ? BigInt(doc.nonce) : BigInt(`0x${Buffer.from(sha256Bytes(`${doc.id}:${doc.nonce}`)).subarray(0, 8).toString("hex")}`);
  return (base + bump) % 2n ** 64n;
}

export function buildRoutes(app: App, hub: Hub): Hono<Env> {
  const api = new Hono<Env>();
  const cfg = app.cfg;
  const local = app.mode === "localnet";
  const keystore = local ? new LocalKeystore(app) : null;

  api.use("*", cors({ origin: (o) => (o === cfg.WEB_ORIGIN || (local && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(o)) ? o : null), allowHeaders: ["content-type", "authorization", "idempotency-key"], allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], maxAge: 600 }));

  api.use("*", async (c, next) => {
    const user = await sessionAddress(app.db, c.req.header("authorization"));
    c.set("user", user);
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    if (c.req.path !== "/v1/stream" && !(await rateLimit(app.db, `rl:${user ?? ip}`, cfg.RATE_LIMIT_PER_MINUTE))) return json(c, { error: "Too many requests. Slow down and try again in a moment." }, 429);
    await next();
  });

  api.onError((e, c) => {
    const status = (e as { status?: number }).status ?? (e instanceof ChainError ? 422 : 500);
    if (status >= 500) log.error({ path: c.req.path, err: e.message, stack: e.stack?.split("\n").slice(0, 4).join(" | ") }, "request failed");
    return json(c, { error: status >= 500 ? "Something went wrong on the server. Nothing was signed or sent." : e.message }, status);
  });

  const user = (c: Context<Env>): string => {
    const u = c.get("user");
    if (!u) throw new AuthError("Connect your wallet first.");
    return u;
  };
  const idem = (c: Context<Env>) => c.req.header("idempotency-key") ?? newId("k");
  const owned = async (c: Context<Env>, id: string) => {
    const s = await getStrategy(app.db, id);
    if (!s) throw new NotFound("Unknown future.");
    if (s.owner !== user(c)) throw new Forbidden("That future belongs to another wallet.");
    return s;
  };

  // ───────────────────────────────────────── environment & reference data
  api.get("/v1/health", async (c) => json(c, { ok: true, mode: app.mode, chain: await app.chain.health() }));
  api.get("/v1/environment", (c) => json(c, environmentInfo(app.mode, { vaultProgram: app.book.programIds.vault, attestation: { threshold: app.book.attestorSet.threshold, of: app.book.attestorSet.keys.length, challengeSeconds: app.book.attestorSet.challengeSeconds, development: cfg.ALLOW_DEV_ATTESTORS === "true" } })));
  api.get("/v1/fixtures", (c) => json(c, app.fx));
  api.get("/v1/assets", async (c) => json(c, await assets(app)));
  api.get("/v1/ops", async (c) => json(c, await ops(app, c.get("user"))));

  api.get("/v1/stream", (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      const remove = hub.add((data) => void stream.writeSSE({ data }).catch(() => (open = false)));
      stream.onAbort(() => {
        open = false;
        remove();
      });
      while (open) await stream.sleep(30_000);
      remove();
    }),
  );

  // ───────────────────────────────────────── auth & wallet
  api.post("/v1/auth/challenge", async (c) => {
    const b = await body(c, z.object({ address: zAddr }));
    return json(c, await createChallenge(app.db, { address: b.address, domain: cfg.AUTH_DOMAIN, uri: cfg.WEB_ORIGIN, chainId: app.mode, mode: app.mode === "localnet" ? "local validator" : "devnet" }));
  });
  api.post("/v1/auth/verify", async (c) => {
    const b = await body(c, z.object({ address: zAddr, message: z.string().max(2000), signature: z.string().max(200) }));
    return json(c, await verifyChallenge(app.db, { ...b, domain: cfg.AUTH_DOMAIN, sessionHours: cfg.SESSION_HOURS, userAgent: c.req.header("user-agent") ?? "" }));
  });
  api.post("/v1/auth/logout", async (c) => {
    await revokeSession(app.db, c.req.header("authorization"));
    return json(c, { ok: true });
  });
  api.post("/v1/wallet/airdrop", async (c) => {
    const u = user(c);
    if (!local) throw new Forbidden("Test funds are only available on a local validator.");
    await app.chain.airdrop(new PublicKey(u));
    await app.publish(["wallet", "portfolio"]);
    return json(c, { ok: true });
  });
  api.get("/v1/wallet/:address/balances", async (c) => {
    const a = c.req.param("address");
    if (!isAddress(a)) throw new BadRequest("Not a Solana address.");
    return json(c, await app.chain.walletBalances(new PublicKey(a)));
  });

  // ───────────────────────────────────────── money
  api.get("/v1/portfolio", async (c) => json(c, await portfolio(app, user(c))));

  api.post("/v1/money/deposit", async (c) => {
    const u = user(c);
    const b = await body(c, z.object({ mint: zAddr, units: zUnits }));
    const have = (await app.chain.walletBalances(new PublicKey(u)))[b.mint] ?? 0n;
    if (b.units > have) throw new BadRequest(`Your wallet holds ${fmtUnits(app.fx, b.mint, have)}.`);
    const label = `Deposit ${fmtUnits(app.fx, b.mint, b.units)}`;
    const plans = await app.chain.depositPlan(new PublicKey(u), b.mint, b.units, label);
    return json(c, await buildIntent(app, { kind: "deposit", owner: u, actor: u, key: idem(c), payload: { mint: b.mint, units: b.units }, plans }));
  });

  api.post("/v1/money/withdraw", async (c) => {
    const u = user(c);
    const b = await body(c, z.object({ mint: zAddr, units: zUnits }));
    const label = `Withdraw ${fmtUnits(app.fx, b.mint, b.units)}`;
    const plans = await app.chain.withdrawPlan(new PublicKey(u), b.mint, b.units, label);
    return json(c, await buildIntent(app, { kind: "withdraw", owner: u, actor: u, key: idem(c), payload: { mint: b.mint, units: b.units }, plans }));
  });

  api.post("/v1/tx/submit", async (c) => {
    const u = user(c);
    const b = await body(c, z.object({ intent: z.string().max(64), signed: z.array(z.string().max(400)).max(20), labels: z.array(z.string()).optional() }));
    return json(c, await submitSigned(app, u, b.intent, b.signed));
  });

  // ───────────────────────────────────────── markets
  api.get("/v1/markets", async (c) => json(c, await markets(app)));
  api.get("/v1/markets/:key", async (c) => json(c, await market(app, c.req.param("key"), c.get("user"))));

  // ───────────────────────────────────────── strategies
  api.get("/v1/strategies", async (c) => json(c, await strategyViews(app, user(c))));
  api.get("/v1/strategies/:id", async (c) => {
    const s = await owned(c, c.req.param("id"));
    const [r] = await records(app, [s]);
    return json(c, strategyView(r!, await chainContext(app)));
  });

  api.post("/v1/strategies", async (c) => {
    const u = user(c);
    const { doc } = await body(c, z.object({ doc: zDoc }));
    await ensureUser(app.db, u);
    const existing = await getStrategy(app.db, doc.id);
    if (existing && existing.owner !== u) throw new Forbidden("That id belongs to another wallet's future.");
    const row = await saveDraft(app.db, u, doc, draftStatus(doc, app.fx, await app.now()), { supersedes: doc.meta?.supersedes ?? null });
    await app.publish(["strategies"]);
    const [r] = await records(app, [row]);
    return json(c, strategyView(r!, await chainContext(app)));
  });

  api.delete("/v1/strategies/:id", async (c) => {
    const u = user(c);
    await owned(c, c.req.param("id"));
    await deleteDraft(app.db, u, c.req.param("id"));
    await app.publish(["strategies"]);
    return json(c, { ok: true });
  });

  const available = async (owner: string | null) => {
    if (!owner) return {};
    const v = await vaultProjection(app.db, app.chain.vaultOf(new PublicKey(owner)).toBase58());
    return Object.fromEntries(Object.entries(v?.balances ?? {}).map(([m, b]) => [m, b.available]));
  };

  api.post("/v1/strategies/prepare", async (c) => {
    const { doc } = await body(c, z.object({ doc: zDoc }));
    const u = c.get("user");
    return json(c, prepareStrategy(doc, { fx: app.fx, now: await app.now(), available: await available(u), lookup: await lookupFor(app, u), environment: `${app.mode === "localnet" ? "Local validator" : "Devnet"} — test tokens only` }));
  });

  /** Build the exact transactions for a reviewed plan. The hash the user reviewed must still match. */
  async function authorization(c: Context<Env>, id: string, expectedHash: string, o: { creator: PublicKey; policy?: { address: string; label: string } }) {
    const u = user(c);
    const s = await owned(c, id);
    if (s.strategyAccount && s.status !== "ACTIVATION_FAILED" && s.status !== "AWAITING_SIGNATURE") throw new Conflict("Already authorized.");
    await app.indexer.syncVault(u).catch(() => undefined);
    const prep = prepareStrategy(s.doc, { fx: app.fx, now: await app.now(), available: await available(u), lookup: await lookupFor(app, u), environment: app.mode });
    if (!prep.ok || !prep.bytes || !prep.hash) throw new BadRequest(prep.issues.find((i) => i.severity === "error")?.message ?? "This future has problems to fix first.");
    if (prep.hash !== expectedHash) throw new Conflict("The plan changed since you reviewed it. Review it again before signing.");
    const vault = app.chain.vaultOf(new PublicKey(u));
    if (!(await app.chain.maybeVault(vault))) throw new BadRequest("Deposit into your vault first: futures reserve from available funds.");
    const supersedesDoc = s.doc.meta?.supersedes?.split("@")[0];
    const old = supersedesDoc ? (await listStrategies(app.db, u)).find((x) => x.doc.id === supersedesDoc && x.id !== id && (x.status === "ACTIVE" || x.status === "PAUSED") && x.strategyAccount) : undefined;
    let built: Awaited<ReturnType<typeof app.chain.authorizePlan>> | null = null;
    let seed = s.strategySeed ?? seedFor(s.doc);
    for (let bump = 0n; bump < 4n && !built; bump++) {
      try {
        seed = s.strategySeed !== null && bump === 0n ? s.strategySeed : seedFor(s.doc, bump);
        built = await app.chain.authorizePlan({ creator: o.creator, vault, strategyId: seed, version: s.doc.version, bytes: prep.bytes, ...(o.policy ? { policy: new PublicKey(o.policy.address) } : {}), ...(old?.strategyAccount && !o.policy ? { supersede: new PublicKey(old.strategyAccount) } : {}) });
      } catch (e) {
        if (!(e instanceof ChainError) || !/already uploaded|already active/.test(e.message)) throw e;
      }
    }
    if (!built) throw new Conflict("Couldn't find a free account id for this future. Start a new version.");
    await updateStrategy(app.db, id, { status: "AWAITING_SIGNATURE", planHash: prep.hash, planBytes: prep.bytes, strategySeed: seed, viaPolicy: o.policy?.address ?? null });
    const reservations = reservationByMint(decodePlan(prep.bytes));
    const intent = await buildIntent(app, {
      kind: "authorize",
      owner: u,
      actor: o.creator.toBase58(),
      key: `${idem(c)}:${prep.hash}`,
      strategyId: id,
      payload: { strategyAccount: built.strategy.toBase58(), reservations, ...(old ? { supersedes: old.id } : {}), ...(o.policy ? { policyLabel: o.policy.label } : {}) },
      plans: built.txs,
    });
    await app.publish(["strategies"]);
    return intent;
  }

  api.post("/v1/strategies/:id/authorize", async (c) => {
    const u = user(c);
    const b = await body(c, z.object({ expectedHash: z.string().regex(/^[0-9a-f]{64}$/) }));
    return json(c, await authorization(c, c.req.param("id"), b.expectedHash, { creator: new PublicKey(u) }));
  });

  api.post("/v1/strategies/:id/fund-with-policy", async (c) => {
    const u = user(c);
    const b = await body(c, z.object({ policyAddress: zAddr }));
    if (!keystore) throw new Forbidden("Server-held agent session keys are only available on localnet.");
    const p = (await listPolicies(app.db, u)).find((x) => x.address === b.policyAddress && x.confirmed);
    if (!p?.state) throw new NotFound("Unknown policy.");
    const s = await owned(c, c.req.param("id"));
    const prep = prepareStrategy(s.doc, { fx: app.fx, now: await app.now(), available: await available(u), lookup: await lookupFor(app, u), environment: app.mode });
    if (!prep.ok || !prep.plan || !prep.hash) throw new BadRequest(prep.issues.find((i) => i.severity === "error")?.message ?? "Fix this future's problems first.");
    // fast feedback only — the program enforces the same limits on-chain
    const v = await vaultProjection(app.db, app.chain.vaultOf(new PublicKey(u)).toBase58());
    const check = checkPolicyForPlan(p.state, prep.plan, { policyEpoch: v?.policyEpoch ?? 0 }, await app.now());
    if (!check.ok) throw new BadRequest(`Outside the policy: ${check.violations.join("; ")}`);
    const session = keystore.load(p.sessionKey);
    const intent = await authorization(c, s.id, prep.hash, { creator: session.publicKey, policy: { address: p.address, label: p.label } });
    await audit(app.db, null, "fund-with-policy", { strategy: s.id, policy: p.address, planHash: prep.hash });
    return json(c, await signAndSubmitAs(app, intent.intent, session));
  });

  api.post("/v1/strategies/:id/new-version", async (c) => {
    const u = user(c);
    const s = await owned(c, c.req.param("id"));
    const doc = newVersion({ ...s.doc, id: newId("fut") }, String(BigInt(`0x${Buffer.from(sha256Bytes(newId("n"))).subarray(0, 5).toString("hex")}`)));
    const d: Strategy = { ...doc, meta: { ...doc.meta, supersedes: `${s.doc.id}@${s.doc.version}` } };
    const row = await saveDraft(app.db, u, d, "DRAFT", { supersedes: s.id });
    await app.publish(["strategies"]);
    const [r] = await records(app, [row]);
    return json(c, strategyView(r!, await chainContext(app)));
  });

  api.post("/v1/strategies/:id/pause", async (c) => {
    const u = user(c);
    const b = await body(c, z.object({ paused: z.boolean() }));
    const s = await owned(c, c.req.param("id"));
    if (!s.strategyAccount || (s.status !== "ACTIVE" && s.status !== "PAUSED")) throw new Conflict("Not active.");
    return json(c, await buildIntent(app, { kind: "pause", owner: u, actor: u, key: idem(c), strategyId: s.id, payload: { paused: b.paused }, plans: app.chain.pausePlan(new PublicKey(u), new PublicKey(s.strategyAccount), b.paused) }));
  });

  api.post("/v1/strategies/:id/cancel", async (c) => {
    const u = user(c);
    const s = await owned(c, c.req.param("id"));
    if (!s.strategyAccount || (s.status !== "ACTIVE" && s.status !== "PAUSED")) throw new Conflict("Not active.");
    return json(c, await buildIntent(app, { kind: "cancel", owner: u, actor: u, key: idem(c), strategyId: s.id, payload: {}, plans: app.chain.cancelPlan(new PublicKey(u), new PublicKey(s.strategyAccount)) }));
  });

  // ───────────────────────────────────────── activity
  api.get("/v1/activity", async (c) => json(c, await listActivity(app.db, user(c))));

  // ───────────────────────────────────────── agents
  async function world(owner: string) {
    const ctx = await chainContext(app);
    const rows = await records(app, await listStrategies(app.db, owner));
    const pols = await policies(app, owner);
    const v = await vaultProjection(app.db, app.chain.vaultOf(new PublicKey(owner)).toBase58());
    const fmt = (m: string, u: bigint) => fmtUnits(app.fx, m, u);
    const summaries: AgentStrategySummary[] = rows.map((r) => {
      const view = strategyView(r, ctx);
      const waiting = view.readiness.map((x, i) => (x.state === "waiting" ? (r.doc.actions[i]?.label ?? `step ${i + 1}`) : x.state === "scheduled" ? `${r.doc.actions[i]?.label ?? `step ${i + 1}`} (scheduled)` : null)).filter((x): x is string => !!x);
      const reserved = r.runtime ? r.runtime.holdings.flatMap((row) => row.map((u2, mi) => (u2 > 0n ? fmt(r.runtime!.plan.mints[mi]!, u2) : null))).filter(Boolean).join(" + ") : "";
      return { id: r.id, title: r.doc.title, status: r.status, reserved, waiting, ...(view.nextWake && view.nextWake !== Infinity ? { nextAt: view.nextWake } : {}), issues: r.lastError ? [r.lastError] : [] };
    });
    return fixtureWorld(() => ctx.now, {
      fixtures: app.fx,
      strategies: () => summaries,
      policies: () => pols.filter((p) => !p.revoked),
      epoch: () => v?.policyEpoch ?? 0,
      available: () => Object.fromEntries(Object.entries(v?.balances ?? {}).map(([m, b]) => [m, b.available])),
    });
  }

  api.get("/v1/agents/sessions", async (c) => json(c, await listSessions(app.db, user(c))));

  api.post("/v1/agents/message", async (c) => {
    const u = user(c);
    const b = await body(c, z.object({ sessionId: z.string().max(64).nullable(), role: z.enum(["researcher", "builder", "monitor", "executor"]), text: z.string().min(1).max(4000) }));
    await ensureUser(app.db, u);
    const now = await app.now();
    let s: SessionRow | null = b.sessionId ? await getSession(app.db, b.sessionId) : null;
    if (s && s.owner !== u) throw new Forbidden("Not your session.");
    if (!s) s = { id: newId("ses"), owner: u, role: b.role as AgentRole, title: b.text.slice(0, 60), createdAt: now, steps: [], provider: "Local assistant (deterministic, not an AI model)", costUsd: 0, conversation: newConversation(b.role as AgentRole) };
    const conv = s.conversation as Conversation;
    s.steps.push({ id: newId("st"), at: now, kind: "message", role: "user", text: b.text });
    const result = runLocalTurn(await world(u), conv, b.text, { draftId: () => newId("fut"), nonce: () => String(BigInt(`0x${Buffer.from(sha256Bytes(newId("n"))).subarray(0, 5).toString("hex")}`)) });
    for (const st of result.steps) {
      const step: AgentStep = {
        id: newId("st"),
        at: now,
        kind: st.kind,
        role: "agent",
        agent: s.role,
        text: st.text,
        ...(st.detail ? { detail: st.detail } : {}),
        ...(st.data !== undefined || st.options ? { data: { ...(typeof st.data === "object" && st.data ? st.data : st.data !== undefined ? { value: st.data } : {}), ...(st.options ? { options: st.options } : {}) } } : {}),
        ...(st.untrusted ? { untrusted: true } : {}),
      };
      s.steps.push(step);
      if (st.kind === "tool" || st.kind === "refusal") await audit(app.db, s.id, st.kind, { role: s.role, text: st.text.slice(0, 300) });
    }
    if (result.draft) {
      const row = await saveDraft(app.db, u, result.draft, draftStatus(result.draft, app.fx, now));
      s.draftId = row.id;
      await logActivity(app.db, u, { at: now, kind: "agent", title: `Strategy Builder drafted “${result.draft.title}”`, detail: "Unfunded draft — review and sign it yourself.", actor: "agent", strategyId: row.id });
    }
    s.conversation = conv;
    await saveSession(app.db, s);
    await app.publish(["agents", "strategies", "activity"]);
    const { owner: _o, conversation: _c, ...rest } = s;
    return json(c, rest);
  });

  api.get("/v1/agents/policies", async (c) => json(c, await policies(app, user(c))));

  api.post("/v1/agents/policies", async (c) => {
    const u = user(c);
    if (!keystore) throw new Forbidden("Server-held agent session keys are only available on localnet.");
    const b = await body(
      c,
      z.object({
        label: z.string().min(1).max(80),
        canCreate: z.boolean(),
        canCancel: z.boolean(),
        allowedMints: z.array(zAddr).min(1).max(6),
        allowedRoutes: z.array(zAddr).max(6),
        allowedRecipients: z.array(zAddr).max(4),
        maxTotal: z.record(z.string(), z.bigint()),
        maxPerAction: z.record(z.string(), z.bigint()),
        maxFeeBps: z.number().int().min(0).max(100),
        expiresAt: z.number().int(),
      }),
    );
    if (b.expiresAt <= (await app.now())) throw new BadRequest("Pick an expiry in the future.");
    const session = keystore.create();
    await app.chain.fundSol(session.publicKey, 2);
    const { policy, txs } = app.chain.createPolicyPlan(
      new PublicKey(u),
      session.publicKey,
      {
        mints: b.allowedMints.map((m) => new PublicKey(m)),
        maxTotal: b.allowedMints.map((m) => b.maxTotal[m] ?? 0n),
        maxPerAction: b.allowedMints.map((m) => b.maxPerAction[m] ?? 0n),
        routes: b.allowedRoutes.map((r) => new PublicKey(r)),
        recipients: b.allowedRecipients.map((r) => new PublicKey(r)),
        maxFeeBps: b.maxFeeBps,
        expiresAt: b.expiresAt,
        canCreate: b.canCreate,
      },
      b.label,
    );
    const { label, ...limits } = b;
    await insertPolicy(app.db, { address: policy.toBase58(), owner: u, vault: app.chain.vaultOf(new PublicKey(u)).toBase58(), label, sessionKey: session.publicKey.toBase58(), limits: { label, ...limits } });
    return json(c, await buildIntent(app, { kind: "policy-create", owner: u, actor: u, key: idem(c), payload: { policy: policy.toBase58(), label }, plans: txs }));
  });

  api.post("/v1/agents/policies/:address/revoke", async (c) => {
    const u = user(c);
    const p = (await listPolicies(app.db, u)).find((x) => x.address === c.req.param("address"));
    if (!p) throw new NotFound("Unknown policy.");
    return json(c, await buildIntent(app, { kind: "policy-revoke", owner: u, actor: u, key: idem(c), payload: { policy: p.address, label: p.label }, plans: app.chain.revokePolicyPlan(new PublicKey(u), new PublicKey(p.address)) }));
  });

  api.post("/v1/agents/kill-switch", async (c) => {
    const u = user(c);
    return json(c, await buildIntent(app, { kind: "kill-switch", owner: u, actor: u, key: idem(c), payload: {}, plans: app.chain.killSwitchPlan(new PublicKey(u)) }));
  });

  // ───────────────────────────────────────── rooms
  const allRooms = async (): Promise<RoomRecord[]> => {
    let rooms = await listRooms(app.db);
    if (!rooms.some((r) => r.sample)) {
      for (const r of sampleRooms(app.fx, app.book.createdAt)) await insertRoom(app.db, r, { owner: null });
      rooms = await listRooms(app.db);
    }
    return rooms;
  };
  api.get("/v1/rooms", async (c) => json(c, await allRooms()));
  api.get("/v1/rooms/:slug", async (c) => json(c, (await allRooms()).find((r) => r.slug === c.req.param("slug")) ?? null));

  api.post("/v1/rooms", async (c) => {
    const u = user(c);
    const b = await body(c, z.object({ strategyId: z.string().max(64), thesis: z.string().min(1).max(2000), risk: z.array(z.string().max(200)).max(12) }));
    const s = await owned(c, b.strategyId);
    const doc: Strategy = { ...structuredClone(s.doc), layout: undefined };
    const hash = planHash(compileStrategy(doc).bytes);
    const now = await app.now();
    const existingId = await roomBySourceDoc(app.db, u, doc.id);
    const rooms = await allRooms();
    const existing = existingId ? rooms.find((r) => r.id === existingId) : undefined;
    if (existing) {
      const version = { version: existing.versions.length + 1, publishedAt: now, doc, hash, thesis: b.thesis, risk: b.risk };
      await insertRoomVersion(app.db, existing.id, version);
      await logActivity(app.db, u, { at: now, kind: "room", title: `Published version ${version.version} of “${existing.title}”`, detail: "Existing copies keep the version they cloned.", actor: "you" });
      await app.publish(["rooms", "activity"]);
      return json(c, (await listRooms(app.db)).find((r) => r.id === existing.id));
    }
    const [rec] = await records(app, [s]);
    const room: RoomRecord = {
      id: newId("room"),
      slug: roomSlug(doc.title, Date.now().toString(36)),
      title: doc.title,
      author: shortAddr(u),
      createdAt: now,
      sample: false,
      versions: [{ version: 1, publishedAt: now, doc, hash, thesis: b.thesis, risk: b.risk }],
      record: rec!.receipts.length ? { kind: "live", note: "Live results from the author's own funded copy on this local validator.", outcomes: [] } : { kind: "none", note: "No track record yet.", outcomes: [] },
      copies: 0,
    };
    await insertRoom(app.db, room, { owner: u, sourceDocId: doc.id });
    await logActivity(app.db, u, { at: now, kind: "room", title: `Published “${room.title}”`, detail: "Followers get the rules, never your holdings or your spending authority.", actor: "you" });
    await app.publish(["rooms", "activity"]);
    return json(c, room);
  });

  api.post("/v1/rooms/:slug/clone", async (c) => {
    const u = user(c);
    const b = await body(c, z.object({ version: z.number().int().min(1) }));
    const r = (await allRooms()).find((x) => x.slug === c.req.param("slug"));
    if (!r) throw new NotFound("Unknown room.");
    const now = await app.now();
    const doc = cloneRoomDoc(r, b.version, { id: newId("fut"), nonce: String(BigInt(`0x${Buffer.from(sha256Bytes(newId("n"))).subarray(0, 5).toString("hex")}`)), now });
    await ensureUser(app.db, u);
    const row = await saveDraft(app.db, u, doc, draftStatus(doc, app.fx, now));
    await bumpCopies(app.db, r.id);
    await logActivity(app.db, u, { at: now, kind: "room", title: `Copied “${r.title}” v${b.version} into your futures`, detail: "Independent draft in your own vault. It needs your own review and signature.", actor: "you", strategyId: row.id });
    await app.publish(["rooms", "activity", "strategies"]);
    const [rec] = await records(app, [row]);
    return json(c, strategyView(rec!, await chainContext(app)));
  });

  // ───────────────────────────────────────── localnet development controls
  if (local) {
    const devOnly = () => {
      if (cfg.ALLOW_DEV_ATTESTORS !== "true") throw new Forbidden("Development attestors are disabled.");
    };
    const outcomeCode = { NO: 0, YES: 1, VOID: 2 } as const;
    api.post("/v1/dev/events/:event/resolve", async (c) => {
      devOnly();
      user(c);
      const b = await body(c, z.object({ outcome: z.enum(["YES", "NO", "VOID"]) }));
      const out = await app.chain.devAttest(c.req.param("event"), outcomeCode[b.outcome], [0, 1]);
      if (!out.ok) throw new ChainError(out.error ?? "Attestation rejected");
      await app.indexer.syncBasics();
      return json(c, { ok: true, signature: out.signature });
    });
    api.post("/v1/dev/events/:event/dispute", async (c) => {
      devOnly();
      user(c);
      const ev = (await chainContext(app)).events[c.req.param("event")];
      if (!ev || ev.status !== "PENDING") throw new Conflict("Only a proposed (pending) outcome can be disputed.");
      const conflicting = ev.outcome === "YES" ? 0 : 1;
      const out = await app.chain.devAttest(c.req.param("event"), conflicting, [1, 2]);
      if (!out.ok) throw new ChainError(out.error ?? "Attestation rejected");
      await app.indexer.syncBasics();
      return json(c, { ok: true, signature: out.signature });
    });
    api.post("/v1/dev/events/:event/observe", async (c) => {
      user(c);
      const b = await body(c, z.object({ units: z.bigint().nonnegative() }));
      const m = app.fx.markets.find((x) => x.eventKey === c.req.param("event"));
      if (!m?.balance) throw new BadRequest("Not a balance event.");
      const w = app.book.watched[m.balance.watched]!;
      const [have] = await app.chain.tokenBalances([new PublicKey(w.address)]);
      if (b.units > have!) await app.chain.devFundWatched(m.balance.watched, b.units - have!);
      const out = await app.chain.observeBalance(new PublicKey(m.eventKey), new PublicKey(w.address));
      if (!out.ok && !/ThresholdNotMet/.test(out.error ?? "")) throw new ChainError(out.error ?? "Observation rejected");
      await app.indexer.syncBasics();
      return json(c, { ok: true, met: out.ok });
    });
    api.post("/v1/dev/pause", async (c) => {
      user(c);
      const b = await body(c, z.object({ paused: z.boolean() }));
      const out = await app.chain.devSetPaused(b.paused);
      if (!out.ok) throw new ChainError(out.error ?? "Rejected");
      await app.indexer.syncBasics();
      return json(c, { ok: true });
    });
  }

  api.notFound((c) => json(c, { error: "Not found" }, 404));
  return api;
}
