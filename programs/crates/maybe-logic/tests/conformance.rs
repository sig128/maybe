//! Conformance: the Rust semantics must reproduce the TypeScript engine's results
//! exactly on the shared fixtures in packages/core/conformance/.
//! Regenerate fixtures with: cd packages/core && npx tsx scripts/write-conformance.ts

use maybe_logic::engine::*;
use maybe_logic::plan::*;
use maybe_logic::predicate::*;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn fixture(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/core/conformance").join(name);
    let s = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("missing fixture {}: {e}", p.display()));
    serde_json::from_str(&s).unwrap()
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn time(v: &Value) -> i64 {
    if v.is_null() {
        INF
    } else {
        v.as_i64().unwrap()
    }
}

fn opt_time(v: &Value) -> Option<i64> {
    if v.is_null() {
        None
    } else {
        Some(v.as_i64().unwrap())
    }
}

fn big(v: &Value) -> u128 {
    match v {
        Value::String(s) => s.parse().unwrap(),
        Value::Number(n) => n.as_u64().unwrap() as u128,
        _ => panic!("not a number: {v}"),
    }
}

fn event_view(v: &Value) -> EventView {
    let status = match v["status"].as_str().unwrap() {
        "OPEN" => STATUS_OPEN,
        "PENDING" => STATUS_PENDING,
        "DISPUTED" => STATUS_DISPUTED,
        "FINAL" => STATUS_FINAL,
        s => panic!("status {s}"),
    };
    let outcome = match v["outcome"].as_str() {
        None => None,
        Some("NO") => Some(OUTCOME_NO),
        Some("YES") => Some(OUTCOME_YES),
        Some("VOID") => Some(OUTCOME_VOID),
        Some(o) => panic!("outcome {o}"),
    };
    let adapter = match v["adapter"].as_str().unwrap() {
        "ATTESTATION" => ADAPTER_ATTESTATION,
        "BALANCE" => ADAPTER_BALANCE,
        a => panic!("adapter {a}"),
    };
    EventView { status, outcome, final_at: opt_time(&v["finalAt"]), adapter, deadline: v.get("deadline").and_then(|d| d.as_i64()) }
}

#[test]
fn plans_round_trip_and_hash() {
    let plans = fixture("plans.json");
    let mut n = 0;
    for p in plans.as_array().unwrap() {
        let bytes = hex(p["hex"].as_str().unwrap());
        let view = PlanView::parse(&bytes).unwrap_or_else(|e| panic!("{} failed to parse: {:?}", p["id"], e));
        assert_eq!(view.reencode(), bytes, "{} re-encodes", p["id"]);
        assert_eq!(to_hex(&Sha256::digest(&bytes)), p["hash"].as_str().unwrap(), "{} hash", p["id"]);
        assert_eq!(view.n_events() as u64, p["events"].as_u64().unwrap());
        assert_eq!(view.n_nodes() as u64, p["nodes"].as_u64().unwrap());
        assert_eq!(view.n_actions() as u64, p["actions"].as_u64().unwrap());
        n += 1;
    }
    assert!(n >= 15);
}

#[test]
fn invalid_plans_rejected_with_same_code() {
    let cases = fixture("invalid_plans.json");
    for c in cases.as_array().unwrap() {
        let bytes = hex(c["hex"].as_str().unwrap());
        match PlanView::parse(&bytes) {
            Ok(_) => panic!("{} unexpectedly parsed", c["name"]),
            Err(e) => assert_eq!(e.code(), c["error"].as_str().unwrap(), "case {}", c["name"]),
        }
    }
}

struct FixtureEnv<'a> {
    now: i64,
    activated_at: i64,
    events: Vec<EventView>,
    self_receipts: &'a [Value],
}

impl EvalEnv for FixtureEnv<'_> {
    fn now(&self) -> i64 {
        self.now
    }
    fn activated_at(&self) -> i64 {
        self.activated_at
    }
    fn event(&self, i: usize) -> Option<EventView> {
        self.events.get(i).copied()
    }
    fn receipt(&self, r: u8, action: u8) -> Option<ReceiptView> {
        if r == NONE {
            self.self_receipts.get(action as usize).map(|v| ReceiptView { executed_at: opt_time(&v["executedAt"]), impossible_at: opt_time(&v["impossibleAt"]) })
        } else {
            Some(ReceiptView { executed_at: None, impossible_at: None })
        }
    }
}

#[test]
fn predicate_times_match() {
    let cases = fixture("predicates.json");
    let mut checked = 0;
    for (ci, c) in cases.as_array().unwrap().iter().enumerate() {
        let bytes = hex(c["hex"].as_str().unwrap());
        let plan = PlanView::parse(&bytes).unwrap();
        let env = FixtureEnv {
            now: c["now"].as_i64().unwrap(),
            activated_at: c["activatedAt"].as_i64().unwrap(),
            events: c["events"].as_array().unwrap().iter().map(event_view).collect(),
            self_receipts: c["selfReceipts"].as_array().unwrap(),
        };
        let times = evaluate_nodes(&plan, &env);
        for (i, exp) in c["expected"].as_array().unwrap().iter().enumerate() {
            assert_eq!(times[i].t, time(&exp["t"]), "case {ci} ({}) node {i} t", c["template"]);
            assert_eq!(times[i].f, time(&exp["f"]), "case {ci} ({}) node {i} f", c["template"]);
            checked += 1;
        }
    }
    assert!(checked > 1000, "checked {checked} node evaluations");
}

fn runtime_from(v: &Value) -> Runtime {
    let status = match v["status"].as_str().unwrap() {
        "ACTIVE" => STATUS_ACTIVE,
        "PAUSED" => STATUS_PAUSED,
        "COMPLETED" => STATUS_COMPLETED,
        "EXPIRED" => STATUS_EXPIRED,
        "CANCELLED" => STATUS_CANCELLED,
        s => panic!("status {s}"),
    };
    let mut holdings = [[0u64; MAX_MINTS]; MAX_ALLOCATIONS];
    for (a, row) in v["holdings"].as_array().unwrap().iter().enumerate() {
        for (m, x) in row.as_array().unwrap().iter().enumerate() {
            holdings[a][m] = big(x) as u64;
        }
    }
    let mut group_claims = [0u8; MAX_GROUPS];
    for (g, x) in v["groupClaims"].as_array().unwrap().iter().enumerate() {
        group_claims[g] = x.as_u64().unwrap() as u8;
    }
    let mut actions = [ActionState::default(); MAX_ACTIONS];
    for (i, a) in v["actions"].as_array().unwrap().iter().enumerate() {
        actions[i] = ActionState {
            runs_done: a["runsDone"].as_u64().unwrap() as u16,
            executed_runs: a["executedRuns"].as_u64().unwrap() as u16,
            first_executed_at: opt_time(&a["firstExecutedAt"]),
            last_executed_at: opt_time(&a["lastExecutedAt"]),
            received: big(&a["received"]) as u64,
            spent: big(&a["spent"]) as u64,
            fees: big(&a["fees"]) as u64,
        };
    }
    Runtime {
        status,
        activated_at: v["activatedAt"].as_i64().unwrap(),
        closed_at: opt_time(&v["closedAt"]),
        holdings,
        group_claims,
        actions,
        exec_nonce: v["execNonce"].as_u64().unwrap(),
    }
}

struct RtEnv<'a> {
    plan: &'a PlanView<'a>,
    rt: &'a Runtime,
    now: i64,
    events: Vec<EventView>,
}

impl EvalEnv for RtEnv<'_> {
    fn now(&self) -> i64 {
        self.now
    }
    fn activated_at(&self) -> i64 {
        self.rt.activated_at
    }
    fn event(&self, i: usize) -> Option<EventView> {
        self.events.get(i).copied()
    }
    fn receipt(&self, r: u8, action: u8) -> Option<ReceiptView> {
        if r == NONE {
            receipt_view(self.plan, self.rt, action as usize, self.now)
        } else {
            None
        }
    }
}

fn reason_name(r: &Readiness) -> (&'static str, Option<&'static str>) {
    match r {
        Readiness::Executable { .. } => ("executable", None),
        Readiness::Waiting => ("waiting", Some("GUARD_PENDING")),
        Readiness::Scheduled { reason, .. } => ("scheduled", Some(reason.code())),
        Readiness::Blocked(e) => ("blocked", Some(e.code())),
        Readiness::Done(e) => ("done", Some(e.code())),
    }
}

#[test]
fn engine_readiness_and_execution_match() {
    let cases = fixture("engine.json");
    let (mut executed, mut rejected) = (0, 0);
    for (ci, c) in cases.as_array().unwrap().iter().enumerate() {
        let bytes = hex(c["hex"].as_str().unwrap());
        let plan = PlanView::parse(&bytes).unwrap();
        let now = c["now"].as_i64().unwrap();
        let paused = c["paused"].as_bool().unwrap();
        let i = c["action"].as_u64().unwrap() as usize;
        let rt = runtime_from(&c["state"]);
        let env = RtEnv { plan: &plan, rt: &rt, now, events: c["events"].as_array().unwrap().iter().map(event_view).collect() };
        let times = evaluate_nodes(&plan, &env);
        let r = readiness(&plan, &rt, i, &times, now, paused);
        let er = &c["readiness"];
        let (state, reason) = reason_name(&r);
        let ctx = format!("case {ci} ({} action {i} @ {now})", c["template"]);
        assert_eq!(state, er["state"].as_str().unwrap(), "{ctx} readiness state");
        if let Some(reason) = reason {
            assert_eq!(reason, er["reason"].as_str().unwrap(), "{ctx} readiness reason");
        }
        match r {
            Readiness::Executable { run, skipped_runs, amount, fee, amount_in, min_out, run_at } => {
                assert_eq!(run as u64, er["run"].as_u64().unwrap(), "{ctx} run");
                assert_eq!(skipped_runs as u64, er["skippedRuns"].as_u64().unwrap(), "{ctx} skipped");
                assert_eq!(amount as u128, big(&er["amount"]), "{ctx} amount");
                assert_eq!(fee as u128, big(&er["fee"]), "{ctx} fee");
                assert_eq!(amount_in as u128, big(&er["amountIn"]), "{ctx} amountIn");
                assert_eq!(min_out, big(&er["minOut"]), "{ctx} minOut");
                assert_eq!(run_at, er["runAt"].as_i64().unwrap(), "{ctx} runAt");
            }
            Readiness::Scheduled { at, .. } => assert_eq!(at, er["at"].as_i64().unwrap(), "{ctx} at"),
            _ => {}
        }
        // execution
        let res = &c["result"];
        let outcome: Result<(Effects, Runtime), &'static str> = (|| {
            let p = prepare(&plan, &rt, i, &times, now, paused, None).map_err(|e| e.code())?;
            let a = plan.action(i);
            let eff = if a.kind == KIND_SWAP {
                let m = u64::try_from(p.min_out).expect("min out fits u64 in fixtures");
                let (spent, recv) = match c["fill"].as_str().unwrap() {
                    "exact-min" => (p.amount_in, m),
                    "better" => (p.amount_in, m + m / 10 + 1),
                    "partial" => (p.amount_in / 2, m),
                    "overspend" => (p.amount_in + 1, m),
                    "underdeliver" => (p.amount_in, m.saturating_sub(1)),
                    "fail" => return Err("ROUTE_FAILED"),
                    f => panic!("fill {f}"),
                };
                settle_swap(&plan, &p, spent, recv).map_err(|e| e.code())?
            } else {
                settle_direct(&plan, &p)
            };
            let mut after = rt;
            apply(&plan, &mut after, &eff, now).map_err(|e| e.code())?;
            Ok((eff, after))
        })();
        match (res["ok"].as_bool().unwrap(), outcome) {
            (true, Ok((eff, after))) => {
                executed += 1;
                let rc = &res["receipt"];
                assert_eq!(eff.run as u64, rc["run"].as_u64().unwrap(), "{ctx} receipt run");
                assert_eq!(eff.skipped_runs as u64, rc["skippedRuns"].as_u64().unwrap(), "{ctx} skipped");
                assert_eq!(eff.taken as u128, big(&rc["amount"]), "{ctx} taken");
                assert_eq!(eff.fee as u128, big(&rc["fee"]), "{ctx} fee");
                assert_eq!(eff.amount_in as u128, big(&rc["amountIn"]), "{ctx} amountIn");
                assert_eq!(eff.amount_out as u128, big(&rc["amountOut"]), "{ctx} amountOut");
                assert_eq!(after.exec_nonce, rc["execNonce"].as_u64().unwrap(), "{ctx} nonce");
                let exp = runtime_from(&res["after"]);
                assert_eq!(after, exp, "{ctx} state after execution");
            }
            (false, Err(code)) => {
                rejected += 1;
                assert_eq!(code, res["code"].as_str().unwrap(), "{ctx} rejection code");
            }
            (ok, got) => panic!("{ctx}: expected ok={ok} ({:?}), got {:?}", res.get("code"), got.map(|(e, _)| e)),
        }
    }
    assert!(executed >= 30 && rejected >= 500, "executed {executed}, rejected {rejected}");
}
