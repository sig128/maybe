//! Agent capability policy checks (port of packages/core/src/policy.ts).

use crate::plan::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyViolation {
    Revoked,
    StaleEpoch,
    Expired,
    CannotCreate,
    OutlivesPolicy,
    FeeAbovePolicy,
    AssetNotAllowed,
    RouteNotAllowed,
    RecipientNotAllowed,
    UncappedProceeds,
    PerActionCap,
    TotalCap,
}

pub struct PolicyView<'a> {
    pub revoked: bool,
    pub epoch: u32,
    pub vault_epoch: u32,
    pub expires_at: i64,
    pub can_create: bool,
    pub max_fee_bps: u16,
    pub allowed_mints: &'a [[u8; 32]],
    pub allowed_routes: &'a [[u8; 32]],
    pub allowed_recipients: &'a [[u8; 32]],
    /// per allowed-mint index
    pub max_total: &'a [u64],
    pub max_per_action: &'a [u64],
    pub spent: &'a [u64],
}

fn step_max(plan: &PlanView, i: usize) -> Option<u64> {
    let a = plan.action(i);
    let runs = a.runs as u64;
    let al = plan.alloc(a.alloc as usize);
    match a.amount_kind {
        AMOUNT_FIXED => a.amount.checked_mul(runs),
        AMOUNT_BPS_OF_ALLOCATION => (((al.amount as u128 * a.bps as u128) / 10_000) as u64).checked_mul(runs),
        _ => {
            if a.amount > 0 {
                a.amount.checked_mul(runs)
            } else if al.mint == a.in_mint {
                Some(al.amount)
            } else {
                None
            }
        }
    }
}

/// Check a plan created by a policy session key. On success returns the per-
/// allowed-mint reservation to add to `spent`.
pub fn check_policy(plan: &PlanView, p: &PolicyView, now: i64) -> Result<[u64; MAX_MINTS], PolicyViolation> {
    if p.revoked {
        return Err(PolicyViolation::Revoked);
    }
    if p.epoch != p.vault_epoch {
        return Err(PolicyViolation::StaleEpoch);
    }
    if now >= p.expires_at {
        return Err(PolicyViolation::Expired);
    }
    if !p.can_create {
        return Err(PolicyViolation::CannotCreate);
    }
    if plan.hdr.expires_at > p.expires_at {
        return Err(PolicyViolation::OutlivesPolicy);
    }
    if plan.hdr.max_fee_bps > p.max_fee_bps {
        return Err(PolicyViolation::FeeAbovePolicy);
    }
    let mint_slot = |m: [u8; 32]| p.allowed_mints.iter().position(|x| *x == m);
    for i in 0..plan.n_mints() {
        if mint_slot(plan.mint(i)).is_none() {
            return Err(PolicyViolation::AssetNotAllowed);
        }
    }
    for i in 0..plan.n_actions() {
        let a = plan.action(i);
        if a.kind == KIND_SWAP && !p.allowed_routes.contains(&plan.r#ref(a.r#ref as usize)) {
            return Err(PolicyViolation::RouteNotAllowed);
        }
        if a.kind == KIND_TRANSFER && !p.allowed_recipients.contains(&plan.r#ref(a.r#ref as usize)) {
            return Err(PolicyViolation::RecipientNotAllowed);
        }
        let slot = mint_slot(plan.mint(a.in_mint as usize)).ok_or(PolicyViolation::AssetNotAllowed)?;
        match step_max(plan, i) {
            None => return Err(PolicyViolation::UncappedProceeds),
            Some(max) => {
                if max > p.max_per_action[slot] {
                    return Err(PolicyViolation::PerActionCap);
                }
            }
        }
    }
    let mut add = [0u64; MAX_MINTS];
    for i in 0..plan.n_allocs() {
        let al = plan.alloc(i);
        let slot = mint_slot(plan.mint(al.mint as usize)).ok_or(PolicyViolation::AssetNotAllowed)?;
        add[slot] = add[slot].checked_add(al.amount).ok_or(PolicyViolation::TotalCap)?;
    }
    for slot in 0..p.allowed_mints.len().min(MAX_MINTS) {
        let used = p.spent[slot];
        if used.checked_add(add[slot]).map_or(true, |v| v > p.max_total[slot]) {
            return Err(PolicyViolation::TotalCap);
        }
    }
    Ok(add)
}
