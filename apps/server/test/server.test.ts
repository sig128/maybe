import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { templateById, buildFixtures, type Strategy } from "@maybe/core";
import type { Db } from "../src/db.ts";
import { loadConfig, ConfigError, isLocalRpc, rpcHost } from "../src/config.ts";
import { claim, defer, enqueue, fail, succeed } from "../src/jobs.ts";
import { createChallenge, rateLimit, sessionAddress, verifyChallenge, AuthError } from "../src/auth.ts";
import { publish } from "../src/outbox.ts";
import {
  authorizationInFlight,
  createIntent,
  ensureUser,
  getIntent,
  getStrategy,
  insertReceipt,
  insertRoom,
  insertRoomVersion,
  leaseIntent,
  listActivity,
  lockStrategy,
  logActivity,
  markEffect,
  releaseIntent,
  saveDraft,
  updateStrategy,
  voidBuiltAuthorizations,
} from "../src/store.ts";
import { withTx } from "../src/db.ts";
import { freshDb, TEST_DB } from "./helpers.ts";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.end();
});

function wallet() {
  const secret = ed25519.utils.randomSecretKey();
  const address = bs58.encode(ed25519.getPublicKey(secret));
  return { address, sign: (msg: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(msg), secret)) };
}

describe("configuration safety", () => {
  it("refuses development attestors, local fixtures and local RPC in production", () => {
    expect(() => loadConfig({ MAYBE_MODE: "production" })).toThrow(ConfigError);
    expect(() => loadConfig({ MAYBE_MODE: "production", ALLOW_DEV_ATTESTORS: "false", RPC_URL: "https://rpc.example.org", DATABASE_URL: "postgres://x:secret@db/maybe", DEV_ATTESTORS: "k1,k2" })).toThrow(/mock signers/);
    expect(() => loadConfig({ MAYBE_MODE: "production", ALLOW_DEV_ATTESTORS: "false", RPC_URL: "https://rpc.example.org", DATABASE_URL: "postgres://x:secret@db/maybe", LOCALNET_BOOK: "/x.json" })).toThrow(/local fixture/);
    expect(() => loadConfig({ MAYBE_MODE: "devnet", RPC_URL: "https://api.mainnet-beta.solana.com", LOCALNET_BOOK: "/x.json" })).toThrow(/mainnet/);
    const ok = loadConfig({ MAYBE_MODE: "production", ALLOW_DEV_ATTESTORS: "false", RPC_URL: "https://rpc.example.org", DATABASE_URL: "postgres://x:secret@db/maybe" });
    expect(ok.MAYBE_MODE).toBe("production");
    expect(loadConfig({}).MAYBE_MODE).toBe("localnet");
  });

  it("localnet (test faucets, dev attestors, server-held keys) only runs against a local validator", () => {
    expect(() => loadConfig({ RPC_URL: "https://api.devnet.solana.com" })).toThrow(/local RPC_URL/);
    expect(() => loadConfig({ MAYBE_MODE: "localnet", RPC_URL: "http://localhost.evil.example:8899" })).toThrow(/local RPC_URL/);
    expect(loadConfig({ RPC_URL: "http://host.docker.internal:8899" }).MAYBE_MODE).toBe("localnet");
    expect(isLocalRpc("http://[::1]:8899")).toBe(true);
    expect(isLocalRpc("http://127.0.0.1:8899")).toBe(true);
    expect(isLocalRpc("not a url")).toBe(false);
    expect(loadConfig({ MAYBE_MODE: "devnet", RPC_URL: "https://api.devnet.solana.com" }).MAYBE_MODE).toBe("devnet");
  });

  it("RPC URLs are shown by host only (provider keys live in the path or query)", () => {
    expect(rpcHost("https://rpc.example.org/v1/secret-key?api-key=abc")).toBe("rpc.example.org");
    expect(rpcHost("::nope")).toBe("an invalid URL");
  });
});

describe("durable jobs", () => {
  it("enqueue is idempotent by key", async () => {
    expect(await enqueue(db, "execute", "execute:S:0:0", { a: 1 })).toBe(true);
    expect(await enqueue(db, "execute", "execute:S:0:0", { a: 2 })).toBe(false);
    const n = await db.query("SELECT count(*)::int AS n FROM jobs WHERE idempotency_key = 'execute:S:0:0'");
    expect(n.rows[0].n).toBe(1);
  });

  it("two workers never claim the same job (FOR UPDATE SKIP LOCKED)", async () => {
    for (let i = 0; i < 20; i++) await enqueue(db, "t-race", `race:${i}`, { i });
    const [a, b] = await Promise.all([claim(db, "w1", ["t-race"], { limit: 20 }), claim(db, "w2", ["t-race"], { limit: 20 })]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(20);
  });

  it("a crashed worker's lease expires and the job comes back; the late finisher is ignored", async () => {
    await enqueue(db, "t-lease", "lease:1", {});
    const [j] = await claim(db, "dead-worker", ["t-lease"], { leaseSeconds: 1 });
    expect(j).toBeDefined();
    expect(await claim(db, "w2", ["t-lease"])).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 1300));
    const [again] = await claim(db, "w2", ["t-lease"]);
    expect(again!.id).toBe(j!.id);
    expect(again!.attempts).toBe(2);
    expect(await succeed(db, j!, "dead-worker")).toBe(false);
    expect(await succeed(db, again!, "w2")).toBe(true);
  });

  it("retryable failures back off; exhausted or fatal ones are dead; deferral doesn't spend attempts", async () => {
    await enqueue(db, "t-retry", "retry:1", {}, { maxAttempts: 2 });
    let [j] = await claim(db, "w", ["t-retry"]);
    expect(await fail(db, j!, "w", "boom", { retryable: true, delaySeconds: 0 })).toBe("RETRY_WAIT");
    await new Promise((r) => setTimeout(r, 50));
    [j] = await claim(db, "w", ["t-retry"]);
    expect(j!.attempts).toBe(2);
    expect(await fail(db, j!, "w", "boom", { retryable: true, delaySeconds: 0 })).toBe("DEAD");
    await enqueue(db, "t-defer", "defer:1", {});
    [j] = await claim(db, "w", ["t-defer"]);
    await defer(db, j!, "w", 1, "waiting");
    const r = await db.query("SELECT state, attempts, last_error FROM jobs WHERE idempotency_key = 'defer:1'");
    expect(r.rows[0]).toEqual({ state: "RETRY_WAIT", attempts: 0, last_error: "waiting" });
  });

  it("a dead job for work that's still valid comes back after a pause, with fresh attempts; never sooner", async () => {
    await enqueue(db, "t-revive", "revive:1", {}, { maxAttempts: 1 });
    const [j] = await claim(db, "w", ["t-revive"]);
    expect(await fail(db, j!, "w", "MinOutNotMet", { retryable: true })).toBe("DEAD");
    // still within the pause: nothing happens
    expect(await enqueue(db, "t-revive", "revive:1", {}, { reviveDeadAfterSeconds: 300 })).toBe(false);
    // without the option a dead job stays dead (finished work keeps its key)
    await db.query("UPDATE jobs SET updated_at = now() - interval '10 minutes' WHERE idempotency_key = 'revive:1'");
    expect(await enqueue(db, "t-revive", "revive:1", {})).toBe(false);
    expect(await enqueue(db, "t-revive", "revive:1", {}, { reviveDeadAfterSeconds: 300 })).toBe(true);
    const r = await db.query("SELECT state, attempts FROM jobs WHERE idempotency_key = 'revive:1'");
    expect(r.rows[0]).toEqual({ state: "QUEUED", attempts: 0 });
    // a succeeded job is never revived
    const [k] = await claim(db, "w", ["t-revive"]);
    expect(await succeed(db, k!, "w")).toBe(true);
    await db.query("UPDATE jobs SET updated_at = now() - interval '10 minutes' WHERE idempotency_key = 'revive:1'");
    expect(await enqueue(db, "t-revive", "revive:1", {}, { reviveDeadAfterSeconds: 300 })).toBe(false);
  });
});

describe("sign-in with Solana", () => {
  const domain = "127.0.0.1:5173";
  it("verifies a signed challenge once, and only for the address and domain it was made for", async () => {
    const w = wallet();
    const ch = await createChallenge(db, { address: w.address, domain, uri: "http://127.0.0.1:5173", chainId: "localnet", mode: "local validator" });
    expect(ch.message).toContain(`${domain} wants you to sign in with your Solana account:\n${w.address}`);
    expect(ch.message).toContain("doesn't move funds");
    const sig = w.sign(ch.message);
    const s = await verifyChallenge(db, { address: w.address, message: ch.message, signature: sig, domain, sessionHours: 1 });
    expect(await sessionAddress(db, `Bearer ${s.session}`)).toBe(w.address);
    // replay
    await expect(verifyChallenge(db, { address: w.address, message: ch.message, signature: sig, domain, sessionHours: 1 })).rejects.toThrow(/expired or was already used/);
    // tokens are stored hashed
    const raw = await db.query("SELECT token_hash FROM wallet_sessions");
    expect(raw.rows.some((r: { token_hash: string }) => r.token_hash === s.session)).toBe(false);
  });

  it("rejects a wrong signer, a wrong domain and a tampered message", async () => {
    const w = wallet();
    const other = wallet();
    const ch = await createChallenge(db, { address: w.address, domain, uri: "http://127.0.0.1:5173", chainId: "localnet", mode: "local validator" });
    await expect(verifyChallenge(db, { address: w.address, message: ch.message, signature: other.sign(ch.message), domain, sessionHours: 1 })).rejects.toThrow(AuthError);
    await expect(verifyChallenge(db, { address: w.address, message: ch.message, signature: w.sign(ch.message), domain: "evil.example", sessionHours: 1 })).rejects.toThrow(/different site/);
    const tampered = ch.message.replace("Version: 1", "Version: 2");
    await expect(verifyChallenge(db, { address: w.address, message: tampered, signature: w.sign(tampered), domain, sessionHours: 1 })).rejects.toThrow(/expired or was already used/);
    expect(await sessionAddress(db, "Bearer not-a-token")).toBeNull();
  });

  it("rate limits per bucket", async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await rateLimit(db, "rl:test", 3));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it("hammering a limited bucket doesn't extend the lockout", async () => {
    for (let i = 0; i < 60; i++) await rateLimit(db, "rl:hammer", 60);
    for (let i = 0; i < 200; i++) expect(await rateLimit(db, "rl:hammer", 60)).toBe(false);
    const r = await db.query("SELECT tokens FROM rate_limits WHERE bucket = 'rl:hammer'");
    expect(r.rows[0].tokens).toBeGreaterThanOrEqual(-1);
    // 60 per minute refills one token a second: usable again ~2 s after the client stops
    await new Promise((res) => setTimeout(res, 2300));
    expect(await rateLimit(db, "rl:hammer", 60)).toBe(true);
  });
});

describe("outbox", () => {
  it("delivers a notification only when the transaction commits", async () => {
    const listener = new pg.Client({ connectionString: TEST_DB });
    await listener.connect();
    await listener.query("LISTEN maybe_changes");
    const got: string[] = [];
    listener.on("notification", (n) => got.push(n.payload ?? ""));
    const c = await db.connect();
    await c.query("BEGIN");
    await publish(c, ["portfolio"]);
    await c.query("ROLLBACK");
    await c.query("BEGIN");
    await publish(c, ["strategies"]);
    await c.query("COMMIT");
    c.release();
    await new Promise((r) => setTimeout(r, 200));
    await listener.end();
    expect(got).toEqual([JSON.stringify({ topics: ["strategies"] })]);
  });
});

describe("store invariants", () => {
  const fx = buildFixtures(1_790_000_000);
  let n = 0;
  const doc = (): Strategy => templateById("flagship")!.build({ now: 1_790_000_000, fixtures: fx, id: () => `t${n++}`, nonce: () => "123" });

  it("an authorized version can't be edited; edits must become a new version", async () => {
    const w = wallet();
    await ensureUser(db, w.address);
    const d = doc();
    await saveDraft(db, w.address, d, "READY");
    await saveDraft(db, w.address, { ...d, title: "edited" }, "READY");
    expect((await getStrategy(db, d.id))!.title).toBe("edited");
    await updateStrategy(db, d.id, { status: "ACTIVE", strategyAccount: "Acct111111111111111111111111111111111111111" });
    await expect(saveDraft(db, w.address, { ...d, title: "sneaky" }, "READY")).rejects.toThrow(/new version/);
    expect((await getStrategy(db, d.id))!.title).toBe("edited");
    // another wallet can't take over an id either
    const other = wallet();
    await ensureUser(db, other.address);
    const d2 = doc();
    await saveDraft(db, w.address, d2, "READY");
    await expect(saveDraft(db, other.address, d2, "READY")).rejects.toThrow();
  });

  it("intents are idempotent by key and effects apply once", async () => {
    const w = wallet();
    const a = await createIntent(db, { id: "int_a", key: `${w.address}:k1`, kind: "deposit", actor: w.address, owner: w.address, payload: { units: 5n } });
    const b = await createIntent(db, { id: "int_b", key: `${w.address}:k1`, kind: "deposit", actor: w.address, owner: w.address, payload: { units: 7n } });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.intent.id).toBe("int_a");
    expect(b.intent.payload.units).toBe(5n);
    expect(await markEffect(db, "int_a", 0)).toBe(true);
    expect(await markEffect(db, "int_a", 0)).toBe(false);
    await db.query("UPDATE intents SET state = 'SUBMITTING' WHERE id = 'int_a'");
    expect(await leaseIntent(db, "int_a", "r1")).toBe(true);
    expect(await leaseIntent(db, "int_a", "r2")).toBe(false);
  });

  it("an intent lease admits one holder: renewals extend it, a second holder waits for release or expiry", async () => {
    const w = wallet();
    await createIntent(db, { id: "int_l", key: `${w.address}:lease`, kind: "deposit", actor: w.address, owner: w.address, payload: {} });
    expect(await leaseIntent(db, "int_l", "api@h:1:aa/run_1")).toBe(false); // only SUBMITTING intents are run
    await db.query("UPDATE intents SET state = 'SUBMITTING' WHERE id = 'int_l'");
    expect(await leaseIntent(db, "int_l", "api@h:1:aa/run_1", 1)).toBe(true);
    // same process, different runIntent call: a different holder, refused while the lease is live
    expect(await leaseIntent(db, "int_l", "api@h:1:aa/run_2")).toBe(false);
    expect(await leaseIntent(db, "int_l", "api@h:1:aa/run_1", 1)).toBe(true); // heartbeat
    await new Promise((r) => setTimeout(r, 1200));
    // the holder stopped beating (crashed): the lease lapses and someone else takes over…
    expect(await leaseIntent(db, "int_l", "worker@h:2:bb/run_3")).toBe(true);
    // …and the old holder's next heartbeat fails, so it stops instead of writing
    expect(await leaseIntent(db, "int_l", "api@h:1:aa/run_1")).toBe(false);
    // release only frees the caller's own lease
    await releaseIntent(db, "int_l", "api@h:1:aa/run_1");
    expect(await leaseIntent(db, "int_l", "api@h:1:aa/run_2")).toBe(false);
    await releaseIntent(db, "int_l", "worker@h:2:bb/run_3");
    expect(await leaseIntent(db, "int_l", "api@h:1:aa/run_2")).toBe(true);
  });

  it("one authorization at a time: newer requests void older unsigned ones; in-flight ones are visible under the row lock", async () => {
    const w = wallet();
    await ensureUser(db, w.address);
    const d = { ...doc(), id: "fut_guard" };
    await saveDraft(db, w.address, d, "READY");
    for (const id of ["int_g1", "int_g2", "int_g3"]) await createIntent(db, { id, key: `${w.address}:${id}`, kind: "authorize", actor: w.address, owner: w.address, strategyId: d.id, payload: { planHash: "aa" } });
    expect(await voidBuiltAuthorizations(db, d.id, "Replaced by a newer authorization request.", "int_g3")).toBe(2);
    expect((await getIntent(db, "int_g1"))!.state).toBe("FAILED");
    expect((await getIntent(db, "int_g3"))!.state).toBe("BUILT");
    expect(await authorizationInFlight(db, d.id)).toBe(false);
    await db.query("UPDATE intents SET state = 'SUBMITTING' WHERE id = 'int_g3'");
    expect(await authorizationInFlight(db, d.id)).toBe(true);
    // a submitted (in-flight) authorization is never voided by an edit
    expect(await voidBuiltAuthorizations(db, d.id, "The future was edited after these transactions were prepared.")).toBe(0);
    // the row lock serializes: a second locker waits until the first transaction ends
    const order: string[] = [];
    await withTx(db, async (c) => {
      await lockStrategy(c, d.id);
      const second = withTx(db, async (c2) => {
        await lockStrategy(c2, d.id);
        order.push("second");
      });
      await new Promise((r) => setTimeout(r, 150));
      order.push("first");
      void second;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual(["first", "second"]);
  });

  it("receipts are unique per (strategy, action, run) and activity dedupes", async () => {
    const rc = { strategy: "S1", planHash: "ab".repeat(32), action: 0, run: 0, skippedRuns: 0, execNonce: 1, at: 1, kind: 1, inMint: "M", outMint: "N", amount: 10n, fee: 1n, amountIn: 9n, amountOut: 18n, recipient: null };
    expect(await insertReceipt(db, "sig1", 5, rc)).toBe(true);
    expect(await insertReceipt(db, "sig2", 6, rc)).toBe(false);
    const w = wallet();
    expect(await logActivity(db, w.address, { at: 1, kind: "execute", title: "x", actor: "keeper" }, "receipt:S1:0:0")).toBe(true);
    expect(await logActivity(db, w.address, { at: 1, kind: "execute", title: "x", actor: "keeper" }, "receipt:S1:0:0")).toBe(false);
    expect((await listActivity(db, w.address)).filter((a) => a.title === "x")).toHaveLength(1);
  });

  it("room versions are append-only", async () => {
    const d = doc();
    await insertRoom(db, { id: "room_t", slug: "t", title: "t", author: "a", createdAt: 1, sample: false, versions: [{ version: 1, publishedAt: 1, doc: d, hash: "h", thesis: "x", risk: [] }], record: { kind: "none", note: "", outcomes: [] }, copies: 0 }, { owner: null });
    await expect(insertRoomVersion(db, "room_t", { version: 1, publishedAt: 2, doc: d, hash: "h2", thesis: "rewrite", risk: [] })).rejects.toThrow();
  });
});
