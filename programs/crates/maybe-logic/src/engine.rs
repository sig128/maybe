//! Readiness, amounts, fees and state effects. Port of packages/core/src/engine.ts.
//! The program calls `prepare` before a route CPI, `settle_swap` with the
//! measured balance deltas after it, and `apply` to update the strategy.

use crate::errors::EngineErr;
use crate::plan::*;
use crate::predicate::*;

pub const STATUS_UPLOADING: u8 = 0;
pub const STATUS_ACTIVE: u8 = 1;
pub const STATUS_PAUSED: u8 = 2;
pub const STATUS_COMPLETED: u8 = 3;
pub const STATUS_EXPIRED: u8 = 4;
pub const STATUS_CANCELLED: u8 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ActionState {
    pub runs_done: u16,
    pub executed_runs: u16,
    pub first_executed_at: Option<i64>,
    pub last_executed_at: Option<i64>,
    pub received: u64,
    pub spent: u64,
    pub fees: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Runtime {
    pub status: u8,
    pub activated_at: i64,
    pub closed_at: Option<i64>,
    pub holdings: [[u64; MAX_MINTS]; MAX_ALLOCATIONS],
    pub group_claims: [u8; MAX_GROUPS],
    pub actions: [ActionState; MAX_ACTIONS],
    pub exec_nonce: u64,
}

impl Runtime {
    /// Fresh runtime at activation: each allocation holds its reservation.
    pub fn activated(plan: &PlanView, now: i64) -> Self {
        let mut holdings = [[0u64; MAX_MINTS]; MAX_ALLOCATIONS];
        for i in 0..plan.n_allocs() {
            let a = plan.alloc(i);
            holdings[i][a.mint as usize] = a.amount;
        }
        Runtime {
            status: STATUS_ACTIVE,
            activated_at: now,
            closed_at: None,
            holdings,
            group_claims: [0; MAX_GROUPS],
            actions: [ActionState::default(); MAX_ACTIONS],
            exec_nonce: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Readiness {
    Executable { run: u16, skipped_runs: u16, amount: u64, fee: u64, amount_in: u64, min_out: u128, run_at: i64 },
    Waiting,
    Scheduled { reason: EngineErr, at: i64 },
    Blocked(EngineErr),
    Done(EngineErr),
}

/// RECEIPT view of action `i` of a strategy (identical to receiptViewFor in engine.ts).
pub fn receipt_view(plan: &PlanView, rt: &Runtime, i: usize, now: i64) -> Option<ReceiptView> {
    if i >= plan.n_actions() {
        return None;
    }
    let st = &rt.actions[i];
    if let Some(t) = st.first_executed_at {
        return Some(ReceiptView { executed_at: Some(t), impossible_at: None });
    }
    let mut impossible = rt.closed_at;
    let dl = plan.action_deadline(&plan.action(i));
    if now >= dl {
        impossible = Some(match impossible {
            None => dl,
            Some(c) => c.min(dl),
        });
    }
    Some(ReceiptView { executed_at: None, impossible_at: impossible })
}

fn mul_div_floor(a: u64, b: u64, c: u64) -> u64 {
    ((a as u128 * b as u128) / c as u128) as u64
}

pub fn compute_amount(plan: &PlanView, rt: &Runtime, i: usize) -> u64 {
    let a = plan.action(i);
    match a.amount_kind {
        AMOUNT_FIXED => a.amount,
        AMOUNT_BPS_OF_ALLOCATION => mul_div_floor(plan.alloc(a.alloc as usize).amount, a.bps as u64, 10_000),
        AMOUNT_BPS_OF_RECEIVED => {
            let v = mul_div_floor(rt.actions[a.amount_ref as usize].received, a.bps as u64, 10_000);
            if a.amount > 0 && v > a.amount {
                a.amount
            } else {
                v
            }
        }
        AMOUNT_ALL_OF_HOLDING => {
            let v = rt.holdings[a.alloc as usize][a.in_mint as usize];
            if a.amount > 0 && v > a.amount {
                a.amount
            } else {
                v
            }
        }
        _ => 0,
    }
}

/// Minimum output for an input amount (rate = output per input x1e9, never below 1).
pub fn required_min_out(a: &ActionDef, amount_in: u64) -> u128 {
    if !a.min_out_is_rate() {
        return a.min_out as u128;
    }
    let v = (amount_in as u128 * a.min_out as u128) / 1_000_000_000u128;
    if v == 0 {
        1
    } else {
        v
    }
}

pub fn readiness(plan: &PlanView, rt: &Runtime, i: usize, times: &[Times], now: i64, execution_paused: bool) -> Readiness {
    if rt.status == STATUS_PAUSED {
        return Readiness::Blocked(EngineErr::StrategyPaused);
    }
    if rt.status != STATUS_ACTIVE {
        return Readiness::Done(EngineErr::StrategyClosed);
    }
    let a = plan.action(i);
    let st = &rt.actions[i];
    if st.runs_done >= a.runs {
        return Readiness::Done(EngineErr::ActionComplete);
    }
    let deadline = plan.action_deadline(&a);
    if now >= deadline {
        return Readiness::Done(EngineErr::DeadlinePassed);
    }
    if a.group != NONE {
        let claim = rt.group_claims[a.group as usize];
        if claim != 0 && claim != a.branch + 1 {
            return Readiness::Done(EngineErr::BranchLost);
        }
    }
    let t = times[a.guard as usize];
    match truth_at(&t, now) {
        Truth::False => return Readiness::Done(EngineErr::GuardFalse),
        Truth::Pending => return Readiness::Waiting,
        Truth::True => {}
    }
    let base = t.t.saturating_add(a.delay as i64);
    let mut run = st.runs_done;
    if a.runs > 1 && !a.catch_up() {
        while run < a.runs - 1 && now >= base.saturating_add((run as i64 + 1) * a.interval as i64) {
            run += 1;
        }
    }
    let run_at = base.saturating_add(run as i64 * a.interval as i64);
    if run_at >= deadline {
        return Readiness::Done(EngineErr::DeadlinePassed);
    }
    if now < run_at {
        return Readiness::Scheduled { reason: if run == 0 { EngineErr::DelayPending } else { EngineErr::RunNotDue }, at: run_at };
    }
    if execution_paused {
        return Readiness::Blocked(EngineErr::ExecutionPaused);
    }
    let amount = compute_amount(plan, rt, i);
    if amount == 0 {
        return Readiness::Blocked(EngineErr::AmountZero);
    }
    if rt.holdings[a.alloc as usize][a.in_mint as usize] < amount {
        return Readiness::Blocked(EngineErr::InsufficientAllocation);
    }
    let fee = if a.kind == KIND_RELEASE { 0 } else { mul_div_floor(amount, a.fee_bps as u64, 10_000) };
    let amount_in = amount - fee;
    let min_out = if a.kind == KIND_SWAP { required_min_out(&a, amount_in) } else { 0 };
    Readiness::Executable { run, skipped_runs: run - st.runs_done, amount, fee, amount_in, min_out, run_at }
}

/// Parameters for one execution, decided before any CPI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Prepared {
    pub action: usize,
    pub run: u16,
    pub skipped_runs: u16,
    pub amount: u64,
    pub fee: u64,
    pub amount_in: u64,
    pub min_out: u128,
}

pub fn readiness_error(r: &Readiness) -> EngineErr {
    match r {
        Readiness::Executable { .. } => EngineErr::NotActive,
        Readiness::Waiting => EngineErr::GuardPending,
        Readiness::Scheduled { reason, .. } => *reason,
        Readiness::Blocked(e) | Readiness::Done(e) => *e,
    }
}

/// Decide whether action `i` may execute now. `expected_run` is the per-action nonce.
pub fn prepare(plan: &PlanView, rt: &Runtime, i: usize, times: &[Times], now: i64, paused: bool, expected_run: Option<u16>) -> Result<Prepared, EngineErr> {
    if i >= plan.n_actions() {
        return Err(EngineErr::BadPlan);
    }
    let r = readiness(plan, rt, i, times, now, paused);
    match r {
        Readiness::Executable { run, skipped_runs, amount, fee, amount_in, min_out, .. } => {
            if let Some(er) = expected_run {
                if er != run {
                    return Err(EngineErr::RunOutOfOrder);
                }
            }
            Ok(Prepared { action: i, run, skipped_runs, amount, fee, amount_in, min_out })
        }
        other => Err(readiness_error(&other)),
    }
}

/// What actually happened, ready to apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Effects {
    pub action: usize,
    pub run: u16,
    pub skipped_runs: u16,
    /// taken from the allocation (input spent + fee)
    pub taken: u64,
    pub fee: u64,
    pub amount_in: u64,
    pub amount_out: u64,
}

/// Post-CPI checks on the measured deltas of the vault's source / destination
/// token accounts. Pro-rata fee on partial fills.
pub fn settle_swap(plan: &PlanView, p: &Prepared, spent_in: u64, received_out: u64) -> Result<Effects, EngineErr> {
    let a = plan.action(p.action);
    if spent_in > p.amount_in {
        return Err(EngineErr::RouteDeltaViolation);
    }
    if spent_in == 0 {
        return Err(EngineErr::RouteFailed);
    }
    let fee = if p.amount_in == 0 { 0 } else { ((p.fee as u128 * spent_in as u128) / p.amount_in as u128) as u64 };
    let need = required_min_out(&a, spent_in);
    if (received_out as u128) < need {
        return Err(EngineErr::MinOutNotMet);
    }
    let taken = spent_in.checked_add(fee).ok_or(EngineErr::Overflow)?;
    Ok(Effects { action: p.action, run: p.run, skipped_runs: p.skipped_runs, taken, fee, amount_in: spent_in, amount_out: received_out })
}

/// Effects of TRANSFER / RELEASE (no route involved).
pub fn settle_direct(plan: &PlanView, p: &Prepared) -> Effects {
    let a = plan.action(p.action);
    if a.kind == KIND_RELEASE {
        Effects { action: p.action, run: p.run, skipped_runs: p.skipped_runs, taken: p.amount, fee: 0, amount_in: p.amount, amount_out: p.amount }
    } else {
        Effects { action: p.action, run: p.run, skipped_runs: p.skipped_runs, taken: p.amount, fee: p.fee, amount_in: p.amount_in, amount_out: p.amount_in }
    }
}

/// Apply effects to the strategy runtime (holdings, claims, counters, nonce).
pub fn apply(plan: &PlanView, rt: &mut Runtime, e: &Effects, now: i64) -> Result<(), EngineErr> {
    let a = plan.action(e.action);
    let al = a.alloc as usize;
    let inm = a.in_mint as usize;
    let h_in = rt.holdings[al][inm].checked_sub(e.taken).ok_or(EngineErr::InsufficientAllocation)?;
    rt.holdings[al][inm] = h_in;
    if a.kind == KIND_SWAP {
        let outm = a.out_mint as usize;
        rt.holdings[al][outm] = rt.holdings[al][outm].checked_add(e.amount_out).ok_or(EngineErr::InsufficientAllocation)?;
    }
    if a.group != NONE && rt.group_claims[a.group as usize] == 0 {
        rt.group_claims[a.group as usize] = a.branch + 1;
    }
    let st = &mut rt.actions[e.action];
    st.runs_done = e.run + 1;
    st.executed_runs = st.executed_runs.checked_add(1).ok_or(EngineErr::Overflow)?;
    if st.first_executed_at.is_none() {
        st.first_executed_at = Some(now);
    }
    st.last_executed_at = Some(now);
    st.received = st.received.checked_add(e.amount_out).ok_or(EngineErr::Overflow)?;
    st.spent = st.spent.checked_add(e.taken).ok_or(EngineErr::Overflow)?;
    st.fees = st.fees.checked_add(e.fee).ok_or(EngineErr::Overflow)?;
    rt.exec_nonce = rt.exec_nonce.checked_add(1).ok_or(EngineErr::Overflow)?;
    Ok(())
}

pub fn all_actions_terminal(plan: &PlanView, rt: &Runtime, times: &[Times], now: i64, paused: bool) -> bool {
    (0..plan.n_actions()).all(|i| matches!(readiness(plan, rt, i, times, now, paused), Readiness::Done(_)))
}

pub const CLOSE_CANCEL: u8 = 1;
pub const CLOSE_EXPIRE: u8 = 2;
pub const CLOSE_COMPLETE: u8 = 3;

/// Close checks (port of closeStrategy). Returns per-mint refunds (by plan mint index).
pub fn close(plan: &PlanView, rt: &mut Runtime, mode: u8, now: i64, signer_is_owner: bool, times: &[Times]) -> Result<[u64; MAX_MINTS], EngineErr> {
    if rt.status != STATUS_ACTIVE && rt.status != STATUS_PAUSED {
        return Err(EngineErr::StrategyClosed);
    }
    match mode {
        CLOSE_CANCEL => {
            if !signer_is_owner {
                return Err(EngineErr::NotOwner);
            }
            if plan.hdr.flags & PLAN_FLAG_CANCEL_LOCKED != 0 && now < plan.hdr.expires_at {
                return Err(EngineErr::CancelLocked);
            }
        }
        CLOSE_EXPIRE => {
            if now < plan.hdr.expires_at {
                return Err(EngineErr::NotExpired);
            }
        }
        _ => {
            if rt.status == STATUS_PAUSED || !all_actions_terminal(plan, rt, times, now, false) {
                return Err(EngineErr::NotComplete);
            }
        }
    }
    let mut refunds = [0u64; MAX_MINTS];
    for al in 0..MAX_ALLOCATIONS {
        for m in 0..MAX_MINTS {
            refunds[m] = refunds[m].checked_add(rt.holdings[al][m]).ok_or(EngineErr::Overflow)?;
            rt.holdings[al][m] = 0;
        }
    }
    rt.status = match mode {
        CLOSE_CANCEL => STATUS_CANCELLED,
        CLOSE_EXPIRE => STATUS_EXPIRED,
        _ => STATUS_COMPLETED,
    };
    rt.closed_at = Some(now);
    Ok(refunds)
}

/// Time / fee checks at activation (port of activateStrategy, minus balances).
pub fn check_activation(plan: &PlanView, now: i64, max_fee_bps_cap: u16) -> Result<(), EngineErr> {
    if plan.hdr.expires_at <= now {
        return Err(EngineErr::ExpiryInPast);
    }
    if plan.hdr.expires_at - now > MAX_STRATEGY_DURATION_SECONDS {
        return Err(EngineErr::DurationTooLong);
    }
    for i in 0..plan.n_actions() {
        let a = plan.action(i);
        if a.deadline != 0 && a.deadline <= now {
            return Err(EngineErr::ExpiryInPast);
        }
    }
    if plan.hdr.max_fee_bps > max_fee_bps_cap {
        return Err(EngineErr::FeeAboveCap);
    }
    Ok(())
}

/// Σ allocation amounts per plan mint index.
pub fn reservation_by_mint(plan: &PlanView) -> Result<[u64; MAX_MINTS], EngineErr> {
    let mut out = [0u64; MAX_MINTS];
    for i in 0..plan.n_allocs() {
        let a = plan.alloc(i);
        out[a.mint as usize] = out[a.mint as usize].checked_add(a.amount).ok_or(EngineErr::Overflow)?;
    }
    Ok(out)
}
