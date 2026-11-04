//! Time-of-truth predicate evaluation. Port of packages/core/src/predicate.ts.
//! Every node evaluates to (t, f): the earliest time it became determinately
//! TRUE / FALSE from recorded finalization timestamps. `INF` = not determined.

use crate::plan::*;

pub const INF: i64 = i64::MAX;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_PENDING: u8 = 1;
pub const STATUS_DISPUTED: u8 = 2;
pub const STATUS_FINAL: u8 = 3;

pub const ADAPTER_ATTESTATION: u8 = 1;
pub const ADAPTER_BALANCE: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventView {
    pub status: u8,
    /// 0 NO, 1 YES, 2 VOID (valid for PENDING / FINAL)
    pub outcome: Option<u8>,
    /// PENDING: scheduled finality; FINAL: when it became final
    pub final_at: Option<i64>,
    pub adapter: u8,
    /// balance adapter only
    pub deadline: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Effective {
    pub fin: bool,
    pub outcome: u8,
    pub final_at: i64,
}

const NOT_FINAL: Effective = Effective { fin: false, outcome: 0, final_at: INF };

/// Lazy finality, identical to `effectiveEvent` in predicate.ts.
pub fn effective(e: Option<&EventView>, now: i64) -> Effective {
    let Some(e) = e else { return NOT_FINAL };
    if e.status == STATUS_FINAL {
        if let (Some(o), Some(t)) = (e.outcome, e.final_at) {
            if t <= now {
                return Effective { fin: true, outcome: o, final_at: t };
            }
        }
    }
    if e.status == STATUS_PENDING {
        if let (Some(o), Some(t)) = (e.outcome, e.final_at) {
            if now >= t {
                return Effective { fin: true, outcome: o, final_at: t };
            }
        }
    }
    if e.adapter == ADAPTER_BALANCE && e.status == STATUS_OPEN {
        if let Some(d) = e.deadline {
            if now > d {
                return Effective { fin: true, outcome: OUTCOME_NO, final_at: d.saturating_add(1) };
            }
        }
    }
    NOT_FINAL
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReceiptView {
    pub executed_at: Option<i64>,
    pub impossible_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Times {
    pub t: i64,
    pub f: i64,
}

pub const PENDING_TIMES: Times = Times { t: INF, f: INF };

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Truth {
    True,
    False,
    Pending,
}

pub fn truth_at(t: &Times, now: i64) -> Truth {
    if t.t <= now {
        Truth::True
    } else if t.f <= now {
        Truth::False
    } else {
        Truth::Pending
    }
}

/// Inputs the evaluator needs from the outside world.
pub trait EvalEnv {
    fn now(&self) -> i64;
    fn activated_at(&self) -> i64;
    fn event(&self, index: usize) -> Option<EventView>;
    /// `ref_index == NONE` means this strategy
    fn receipt(&self, ref_index: u8, action: u8) -> Option<ReceiptView>;
}

fn kth_smallest(vals: &mut [i64], k: usize) -> i64 {
    vals.sort_unstable();
    if k == 0 || k > vals.len() {
        INF
    } else {
        vals[k - 1]
    }
}

/// Evaluate every node in index order (children always precede parents).
pub fn evaluate_nodes(plan: &PlanView, env: &impl EvalEnv) -> [Times; MAX_NODES] {
    let mut out = [PENDING_TIMES; MAX_NODES];
    let now = env.now();
    for i in 0..plan.n_nodes() {
        let n = plan.node(i);
        let kid = |c: usize| out[n.children[c] as usize];
        let nk = n.n as usize;
        let mut r = match n.op {
            OP_ALWAYS => {
                let a = env.activated_at();
                Times { t: if a <= now { a } else { INF }, f: INF }
            }
            OP_OUTCOME => {
                let ev = env.event(n.a as usize);
                let eff = effective(ev.as_ref(), now);
                if !eff.fin {
                    PENDING_TIMES
                } else if eff.outcome == n.b {
                    Times { t: eff.final_at, f: INF }
                } else {
                    Times { t: INF, f: eff.final_at }
                }
            }
            OP_NOT => {
                let c = kid(0);
                Times { t: c.f, f: c.t }
            }
            OP_AND => {
                let mut t = i64::MIN;
                let mut f = INF;
                for c in 0..nk {
                    t = t.max(kid(c).t);
                    f = f.min(kid(c).f);
                }
                Times { t, f }
            }
            OP_OR => {
                let mut t = INF;
                let mut f = i64::MIN;
                for c in 0..nk {
                    t = t.min(kid(c).t);
                    f = f.max(kid(c).f);
                }
                Times { t, f }
            }
            OP_ATLEAST => {
                let mut ts = [INF; MAX_CHILDREN];
                let mut fs = [INF; MAX_CHILDREN];
                for c in 0..nk {
                    ts[c] = kid(c).t;
                    fs[c] = kid(c).f;
                }
                let k = n.k as usize;
                Times { t: kth_smallest(&mut ts[..nk], k), f: kth_smallest(&mut fs[..nk], nk + 1 - k) }
            }
            OP_VETO => {
                let trig = kid(0);
                let big_t = if trig.t == INF { INF } else { trig.t.saturating_add(n.param) };
                let ev = env.event(n.a as usize);
                let eff = effective(ev.as_ref(), now);
                if eff.fin {
                    if eff.outcome == n.b {
                        if eff.final_at <= big_t {
                            Times { t: INF, f: eff.final_at }
                        } else {
                            Times { t: big_t, f: INF }
                        }
                    } else {
                        Times { t: big_t.min(eff.final_at), f: INF }
                    }
                } else {
                    Times { t: if big_t <= now { big_t } else { INF }, f: INF }
                }
            }
            OP_RECEIPT => match env.receipt(n.a, n.b) {
                None => PENDING_TIMES,
                Some(rv) => match rv.executed_at {
                    Some(t) => Times { t, f: INF },
                    None => Times { t: INF, f: rv.impossible_at.unwrap_or(INF) },
                },
            },
            OP_AFTER => Times { t: if n.param <= now { n.param } else { INF }, f: INF },
            _ => PENDING_TIMES,
        };
        // a node can never be both TRUE and FALSE: fail closed
        if r.t != INF && r.f != INF {
            r = PENDING_TIMES;
        }
        out[i] = r;
    }
    out
}
