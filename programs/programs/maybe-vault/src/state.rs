use anchor_lang::prelude::*;
use maybe_logic::engine::{ActionState, Runtime};
use maybe_logic::plan::{MAX_ACTIONS, MAX_ALLOCATIONS, MAX_GROUPS, MAX_MINTS, MAX_PLAN_BYTES};

/// Sentinel for "no timestamp" in zero-copy accounts.
pub const NO_TIME: i64 = i64::MIN;

pub const MAX_ASSETS: usize = 16;
pub const MAX_ROUTES: usize = 4;
pub const MAX_VAULT_MINTS: usize = 8;
pub const MAX_ATTESTORS: usize = 5;
pub const MAX_POLICY_MINTS: usize = 6;
pub const MAX_POLICY_ROUTES: usize = 6;
pub const MAX_POLICY_RECIPIENTS: usize = 4;

pub const ADAPTER_ATTESTATION: u8 = 1;
pub const ADAPTER_BALANCE: u8 = 2;

#[zero_copy]
pub struct AssetEntry {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    /// fee destination token account for this mint
    pub treasury: Pubkey,
    pub decimals: u8,
    pub enabled: u8,
    pub _pad: [u8; 6],
}

#[zero_copy]
pub struct RouteEntry {
    pub program_id: Pubkey,
    pub kind: u8,
    pub enabled: u8,
    pub _pad: [u8; 6],
}

/// Global configuration. The admin can list assets / routes / attestor sets
/// and pause NEW executions. The admin has no instruction that moves vault
/// funds, edits plans, or blocks withdrawals, cancellations or refunds.
#[account(zero_copy)]
pub struct Config {
    pub admin: Pubkey,
    pub treasury_owner: Pubkey,
    pub max_fee_bps_cap: u16,
    pub allow_dev_attestors: u8,
    pub paused_execution: u8,
    pub n_assets: u8,
    pub n_routes: u8,
    pub bump: u8,
    pub _pad: u8,
    pub assets: [AssetEntry; MAX_ASSETS],
    pub routes: [RouteEntry; MAX_ROUTES],
}

impl Config {
    pub fn asset(&self, mint: &Pubkey) -> Option<&AssetEntry> {
        self.assets[..self.n_assets as usize].iter().find(|a| a.mint == *mint)
    }
    pub fn route(&self, kind: u8) -> Option<&RouteEntry> {
        self.routes[..self.n_routes as usize].iter().find(|r| r.kind == kind)
    }
}

#[zero_copy]
pub struct MintBalance {
    pub mint: Pubkey,
    /// canonical ATA(vault, mint, token_program)
    pub token_account: Pubkey,
    pub available: u64,
    pub reserved: u64,
}

#[account(zero_copy)]
pub struct Vault {
    pub owner: Pubkey,
    pub vault_id: u64,
    pub strategy_count: u64,
    pub policy_epoch: u32,
    pub n_balances: u8,
    pub bump: u8,
    pub _pad: [u8; 2],
    pub balances: [MintBalance; MAX_VAULT_MINTS],
}

impl Vault {
    pub fn entry(&self, mint: &Pubkey) -> Option<usize> {
        self.balances[..self.n_balances as usize].iter().position(|b| b.mint == *mint)
    }
}

#[zero_copy]
pub struct ActionStateZc {
    pub first_executed_at: i64,
    pub last_executed_at: i64,
    pub received: u64,
    pub spent: u64,
    pub fees: u64,
    pub runs_done: u16,
    pub executed_runs: u16,
    pub _pad: [u8; 4],
}

#[account(zero_copy)]
pub struct Strategy {
    pub vault: Pubkey,
    pub owner: Pubkey,
    /// signer that created the plan (owner or an agent session key)
    pub creator: Pubkey,
    /// policy account when created by a session key, default otherwise
    pub policy: Pubkey,
    pub plan_hash: [u8; 32],
    pub strategy_id: u64,
    pub created_at: i64,
    pub activated_at: i64,
    pub closed_at: i64,
    pub exec_nonce: u64,
    pub version: u32,
    pub plan_len: u16,
    pub written: u16,
    pub status: u8,
    pub bump: u8,
    pub group_claims: [u8; MAX_GROUPS],
    pub _pad0: [u8; 6],
    pub holdings: [[u64; MAX_MINTS]; MAX_ALLOCATIONS],
    pub actions: [ActionStateZc; MAX_ACTIONS],
    pub plan: [u8; MAX_PLAN_BYTES],
}

fn opt(t: i64) -> Option<i64> {
    if t == NO_TIME {
        None
    } else {
        Some(t)
    }
}

fn unopt(t: Option<i64>) -> i64 {
    t.unwrap_or(NO_TIME)
}

impl Strategy {
    pub fn plan_bytes(&self) -> Vec<u8> {
        self.plan[..self.plan_len as usize].to_vec()
    }

    pub fn runtime(&self) -> Runtime {
        let mut actions = [ActionState::default(); MAX_ACTIONS];
        for (i, a) in self.actions.iter().enumerate() {
            actions[i] = ActionState {
                runs_done: a.runs_done,
                executed_runs: a.executed_runs,
                first_executed_at: opt(a.first_executed_at),
                last_executed_at: opt(a.last_executed_at),
                received: a.received,
                spent: a.spent,
                fees: a.fees,
            };
        }
        Runtime {
            status: self.status,
            activated_at: self.activated_at,
            closed_at: opt(self.closed_at),
            holdings: self.holdings,
            group_claims: self.group_claims,
            actions,
            exec_nonce: self.exec_nonce,
        }
    }

    pub fn store(&mut self, rt: &Runtime) {
        self.status = rt.status;
        self.activated_at = rt.activated_at;
        self.closed_at = unopt(rt.closed_at);
        self.holdings = rt.holdings;
        self.group_claims = rt.group_claims;
        self.exec_nonce = rt.exec_nonce;
        for (i, a) in rt.actions.iter().enumerate() {
            self.actions[i] = ActionStateZc {
                first_executed_at: unopt(a.first_executed_at),
                last_executed_at: unopt(a.last_executed_at),
                received: a.received,
                spent: a.spent,
                fees: a.fees,
                runs_done: a.runs_done,
                executed_runs: a.executed_runs,
                _pad: [0; 4],
            };
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct AttestorSet {
    pub set_id: u64,
    pub keys: [Pubkey; MAX_ATTESTORS],
    pub n_keys: u8,
    pub threshold: u8,
    pub adjudication_threshold: u8,
    /// bitmap over key indices
    pub revoked: u8,
    pub is_dev: bool,
    pub challenge_seconds: u32,
    pub dispute_timeout_seconds: u32,
    pub bump: u8,
}

/// Canonical outcome registry entry. Its address commits to the adapter, the
/// venue market id, the rule version and the resolver binding.
#[account]
#[derive(InitSpace)]
pub struct OutcomeEvent {
    pub adapter: u8,
    pub venue: u8,
    pub market_id_hash: [u8; 32],
    pub rule_hash: [u8; 32],
    /// attestor set (attestation) or watched token account (balance)
    pub binding: Pubkey,
    pub status: u8,
    pub outcome: u8,
    pub proposed_at: i64,
    pub final_at: i64,
    pub disputed_at: i64,
    pub last_nonce: u64,
    pub threshold: u64,
    pub deadline: i64,
    pub watched_mint: Pubkey,
    pub bump: u8,
}

#[account(zero_copy)]
pub struct Policy {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub session_key: Pubkey,
    pub allowed_mints: [Pubkey; MAX_POLICY_MINTS],
    pub allowed_routes: [Pubkey; MAX_POLICY_ROUTES],
    pub allowed_recipients: [Pubkey; MAX_POLICY_RECIPIENTS],
    pub max_total: [u64; MAX_POLICY_MINTS],
    pub max_per_action: [u64; MAX_POLICY_MINTS],
    pub spent: [u64; MAX_POLICY_MINTS],
    pub expires_at: i64,
    pub epoch: u32,
    pub max_fee_bps: u16,
    pub n_mints: u8,
    pub n_routes: u8,
    pub n_recipients: u8,
    pub can_create: u8,
    pub can_cancel: u8,
    pub revoked: u8,
    pub bump: u8,
    pub _pad: [u8; 3],
}

#[event]
pub struct ExecutionReceipt {
    pub strategy: Pubkey,
    pub plan_hash: [u8; 32],
    pub action: u8,
    pub run: u16,
    pub skipped_runs: u16,
    pub exec_nonce: u64,
    pub at: i64,
    pub kind: u8,
    pub in_mint: Pubkey,
    pub out_mint: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub amount_in: u64,
    pub amount_out: u64,
    pub recipient: Pubkey,
}

#[event]
pub struct StrategyActivated {
    pub strategy: Pubkey,
    pub vault: Pubkey,
    pub plan_hash: [u8; 32],
    pub reserved: [u64; MAX_MINTS],
    pub by_policy: bool,
}

#[event]
pub struct StrategyClosed {
    pub strategy: Pubkey,
    pub mode: u8,
    pub refunded: [u64; MAX_MINTS],
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Withdrawn {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EventResolved {
    pub event: Pubkey,
    pub status: u8,
    pub outcome: u8,
    pub final_at: i64,
}

#[event]
pub struct PolicyChanged {
    pub policy: Pubkey,
    pub revoked: bool,
    pub epoch: u32,
}

#[cfg(test)]
mod layout_tests {
    //! The TypeScript SDK decodes these zero-copy accounts by fixed offsets
    //! (packages/sdk/src/accounts.ts). These assertions pin the layout.
    use super::*;
    use std::mem::{offset_of, size_of};

    #[test]
    fn zero_copy_layouts_are_pinned() {
        assert_eq!(size_of::<Config>(), 1896);
        assert_eq!(offset_of!(Config, assets), 72);
        assert_eq!(offset_of!(Config, routes), 1736);
        assert_eq!(size_of::<AssetEntry>(), 104);
        assert_eq!(size_of::<RouteEntry>(), 40);
        assert_eq!(size_of::<Vault>(), 696);
        assert_eq!(offset_of!(Vault, policy_epoch), 48);
        assert_eq!(offset_of!(Vault, balances), 56);
        assert_eq!(size_of::<MintBalance>(), 80);
        assert_eq!(size_of::<Strategy>(), 3592);
        assert_eq!(offset_of!(Strategy, strategy_id), 160);
        assert_eq!(offset_of!(Strategy, version), 200);
        assert_eq!(offset_of!(Strategy, plan_len), 204);
        assert_eq!(offset_of!(Strategy, status), 208);
        assert_eq!(offset_of!(Strategy, group_claims), 210);
        assert_eq!(offset_of!(Strategy, holdings), 224);
        assert_eq!(offset_of!(Strategy, actions), 416);
        assert_eq!(offset_of!(Strategy, plan), 992);
        assert_eq!(size_of::<ActionStateZc>(), 48);
        assert_eq!(size_of::<Policy>(), 776);
        assert_eq!(offset_of!(Policy, max_total), 608);
        assert_eq!(offset_of!(Policy, expires_at), 752);
        assert_eq!(offset_of!(Policy, epoch), 760);
        assert_eq!(offset_of!(Policy, n_mints), 766);
        assert_eq!(offset_of!(Policy, revoked), 771);
    }
}
