//! maybe_vault — vaults, committed strategy plans, reservations, bounded
//! execution, outcome registry and agent capability policies.
//! Semantics live in the host-tested `maybe-logic` crate; handlers here only
//! load accounts, validate account relationships, perform CPIs and persist.
#![allow(unexpected_cfgs)]
#![allow(clippy::result_large_err)]

use anchor_lang::compat::solana_instructions_sysvar::load_instruction_at_checked;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use maybe_logic::engine as eng;
use maybe_logic::plan::{self as pl, PlanView};
use maybe_logic::predicate as pr;
use maybe_logic::{attest, policy as po, tokens as tk};

pub mod errors;
pub mod state;

use errors::*;
use state::*;

declare_id!("pUZiiWnMzroxAxPDJsjH337T5Fm9WNy92EiLNFGHgyy");

pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");

fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

fn is_token_program(k: &Pubkey) -> bool {
    *k == TOKEN_PROGRAM_ID || *k == TOKEN_2022_PROGRAM_ID
}

fn token_info(acc: &AccountInfo) -> Result<tk::TokenAccountInfo> {
    require!(is_token_program(acc.owner), MaybeError::InvalidAccount);
    let data = acc.try_borrow_data()?;
    tk::parse_token_account(&data).map_err(token_err)
}

fn token_amount(acc: &AccountInfo) -> Result<u64> {
    Ok(token_info(acc)?.amount)
}

pub fn ata_address(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM_ID).0
}

#[allow(clippy::too_many_arguments)]
fn transfer_checked<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    seeds: Option<&[&[u8]]>,
) -> Result<()> {
    let ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*from.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data: tk::transfer_checked_data(amount, decimals).to_vec(),
    };
    let infos = [from.clone(), mint.clone(), to.clone(), authority.clone(), token_program.clone()];
    match seeds {
        Some(s) => invoke_signed(&ix, &infos, &[s])?,
        None => invoke(&ix, &infos)?,
    }
    Ok(())
}

fn event_view(e: &OutcomeEvent) -> pr::EventView {
    let has = e.status == pr::STATUS_PENDING || e.status == pr::STATUS_FINAL || e.status == pr::STATUS_DISPUTED;
    pr::EventView {
        status: e.status,
        outcome: if has { Some(e.outcome) } else { None },
        final_at: if has { Some(e.final_at) } else { None },
        adapter: e.adapter,
        deadline: if e.adapter == ADAPTER_BALANCE { Some(e.deadline) } else { None },
    }
}

/// Evaluation environment over loaded accounts.
struct Env<'p> {
    now: i64,
    plan: &'p PlanView<'p>,
    rt: &'p eng::Runtime,
    events: [Option<pr::EventView>; pl::MAX_EVENTS],
    /// external strategies referenced by RECEIPT nodes: (ref index, plan bytes, runtime)
    ext: Vec<(u8, Vec<u8>, eng::Runtime)>,
}

impl pr::EvalEnv for Env<'_> {
    fn now(&self) -> i64 {
        self.now
    }
    fn activated_at(&self) -> i64 {
        self.rt.activated_at
    }
    fn event(&self, i: usize) -> Option<pr::EventView> {
        self.events.get(i).copied().flatten()
    }
    fn receipt(&self, r: u8, action: u8) -> Option<pr::ReceiptView> {
        if r == pl::NONE {
            return eng::receipt_view(self.plan, self.rt, action as usize, self.now);
        }
        let (_, bytes, rt) = self.ext.iter().find(|(i, _, _)| *i == r)?;
        let p = PlanView::parse(bytes).ok()?;
        eng::receipt_view(&p, rt, action as usize, self.now)
    }
}

/// Ref indices used by RECEIPT nodes, ascending, unique.
fn receipt_refs(plan: &PlanView) -> Vec<u8> {
    let mut v: Vec<u8> = (0..plan.n_nodes()).map(|i| plan.node(i)).filter(|n| n.op == pl::OP_RECEIPT && n.a != pl::NONE).map(|n| n.a).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// Load events + receipt strategies from remaining accounts. Returns the env pieces and the next index.
fn load_context<'info>(plan: &PlanView, rem: &'info [AccountInfo<'info>]) -> Result<([Option<pr::EventView>; pl::MAX_EVENTS], Vec<(u8, Vec<u8>, eng::Runtime)>, usize)> {
    let mut events = [None; pl::MAX_EVENTS];
    require!(rem.len() >= plan.n_events(), MaybeError::EventMismatch);
    for i in 0..plan.n_events() {
        let acc = &rem[i];
        require!(acc.key.to_bytes() == plan.event(i), MaybeError::EventMismatch);
        let ev: Account<OutcomeEvent> = Account::try_from(acc)?;
        events[i] = Some(event_view(&ev));
    }
    let mut idx = plan.n_events();
    let mut ext = Vec::new();
    for r in receipt_refs(plan) {
        let acc = rem.get(idx).ok_or(MaybeError::InvalidAccount)?;
        require!(acc.key.to_bytes() == plan.r#ref(r as usize), MaybeError::InvalidAccount);
        let loader: AccountLoader<Strategy> = AccountLoader::try_from(acc)?;
        let s = loader.load()?;
        ext.push((r, s.plan_bytes(), s.runtime()));
        idx += 1;
    }
    Ok((events, ext, idx))
}

fn vault_seeds_owned(owner: &Pubkey, vault_id: u64, bump: u8) -> (Vec<u8>, [u8; 8], [u8; 1], Pubkey) {
    (b"vault".to_vec(), vault_id.to_le_bytes(), [bump], *owner)
}

#[program]
pub mod maybe_vault {
    use super::*;

    // ------------------------------------------------------------ admin
    pub fn init_config(ctx: Context<InitConfig>, max_fee_bps_cap: u16, allow_dev_attestors: bool, treasury_owner: Pubkey) -> Result<()> {
        require!(max_fee_bps_cap <= pl::MAX_FEE_BPS, MaybeError::FeeAboveCap);
        let mut c = ctx.accounts.config.load_init()?;
        c.admin = ctx.accounts.admin.key();
        c.treasury_owner = treasury_owner;
        c.max_fee_bps_cap = max_fee_bps_cap;
        c.allow_dev_attestors = allow_dev_attestors as u8;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// List or delist an asset. Validates the token program and the Token-2022
    /// extension allowlist; records decimals and the fee treasury account.
    pub fn set_asset(ctx: Context<SetAsset>, enabled: bool) -> Result<()> {
        let mint = &ctx.accounts.mint;
        let program = *mint.owner;
        require!(is_token_program(&program), MaybeError::InvalidAccount);
        let info = {
            let data = mint.try_borrow_data()?;
            tk::check_mint(&data, program == TOKEN_2022_PROGRAM_ID).map_err(token_err)?
        };
        let t = token_info(&ctx.accounts.treasury)?;
        require!(*ctx.accounts.treasury.owner == program && t.mint == mint.key().to_bytes(), MaybeError::TokenAccountMismatch);
        let mut c = ctx.accounts.config.load_mut()?;
        let n = c.n_assets as usize;
        let idx = match c.assets[..n].iter().position(|a| a.mint == mint.key()) {
            Some(i) => i,
            None => {
                require!(n < MAX_ASSETS, MaybeError::TooManyEntries);
                c.n_assets += 1;
                n
            }
        };
        c.assets[idx] = AssetEntry { mint: mint.key(), token_program: program, treasury: ctx.accounts.treasury.key(), decimals: info.decimals, enabled: enabled as u8, _pad: [0; 6] };
        Ok(())
    }

    pub fn set_route(ctx: Context<AdminOnly>, kind: u8, program_id: Pubkey, enabled: bool) -> Result<()> {
        require!((pl::ROUTE_CP_SWAP..=pl::ROUTE_OUTCOME_REDEEM).contains(&kind), MaybeError::InvalidArgument);
        let mut c = ctx.accounts.config.load_mut()?;
        let n = c.n_routes as usize;
        let idx = match c.routes[..n].iter().position(|r| r.kind == kind) {
            Some(i) => i,
            None => {
                require!(n < MAX_ROUTES, MaybeError::TooManyEntries);
                c.n_routes += 1;
                n
            }
        };
        c.routes[idx] = RouteEntry { program_id, kind, enabled: enabled as u8, _pad: [0; 6] };
        Ok(())
    }

    /// Emergency pause of NEW executions only. Withdrawals, cancellations,
    /// releases at expiry and refunds are never paused.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.load_mut()?.paused_execution = paused as u8;
        Ok(())
    }

    /// One-way switch: once development attestors are disabled they can never be
    /// re-enabled for this deployment (production configs start disabled).
    pub fn disable_dev_attestors(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.load_mut()?.allow_dev_attestors = 0;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn init_attestor_set(
        ctx: Context<InitAttestorSet>,
        set_id: u64,
        keys: Vec<Pubkey>,
        threshold: u8,
        adjudication_threshold: u8,
        challenge_seconds: u32,
        dispute_timeout_seconds: u32,
        is_dev: bool,
    ) -> Result<()> {
        let c = ctx.accounts.config.load()?;
        if is_dev && c.allow_dev_attestors == 0 {
            return err!(MaybeError::DevAttestorForbidden);
        }
        require!(!keys.is_empty() && keys.len() <= MAX_ATTESTORS, MaybeError::InvalidArgument);
        for i in 0..keys.len() {
            for j in 0..i {
                require!(keys[i] != keys[j], MaybeError::InvalidArgument);
            }
        }
        let n = keys.len() as u8;
        require!(threshold >= 1 && threshold <= n, MaybeError::InvalidArgument);
        require!(adjudication_threshold >= threshold && adjudication_threshold <= n, MaybeError::InvalidArgument);
        let s = &mut ctx.accounts.attestor_set;
        s.set_id = set_id;
        s.keys = [Pubkey::default(); MAX_ATTESTORS];
        s.keys[..keys.len()].copy_from_slice(&keys);
        s.n_keys = n;
        s.threshold = threshold;
        s.adjudication_threshold = adjudication_threshold;
        s.revoked = 0;
        s.is_dev = is_dev;
        s.challenge_seconds = challenge_seconds;
        s.dispute_timeout_seconds = dispute_timeout_seconds;
        s.bump = ctx.bumps.attestor_set;
        Ok(())
    }

    pub fn revoke_attestor(ctx: Context<RevokeAttestor>, index: u8) -> Result<()> {
        let s = &mut ctx.accounts.attestor_set;
        require!(index < s.n_keys, MaybeError::InvalidArgument);
        s.revoked |= 1 << index;
        Ok(())
    }

    // ------------------------------------------------------------ outcome registry
    pub fn create_event(ctx: Context<CreateEvent>, adapter: u8, venue: u8, market_id_hash: [u8; 32], rule_hash: [u8; 32], threshold: u64, deadline: i64) -> Result<()> {
        let binding = &ctx.accounts.binding;
        let e = &mut ctx.accounts.event;
        match adapter {
            ADAPTER_ATTESTATION => {
                require!(*binding.owner == crate::ID, MaybeError::InvalidAccount);
                let data = binding.try_borrow_data()?;
                require!(data.len() >= 8 && data[..8] == *AttestorSet::DISCRIMINATOR, MaybeError::InvalidAccount);
                e.watched_mint = Pubkey::default();
            }
            ADAPTER_BALANCE => {
                let t = token_info(binding)?;
                require!(threshold > 0 && deadline > now()?, MaybeError::InvalidArgument);
                e.watched_mint = Pubkey::new_from_array(t.mint);
            }
            _ => return err!(MaybeError::InvalidArgument),
        }
        e.adapter = adapter;
        e.venue = venue;
        e.market_id_hash = market_id_hash;
        e.rule_hash = rule_hash;
        e.binding = binding.key();
        e.status = pr::STATUS_OPEN;
        e.outcome = 0;
        e.proposed_at = 0;
        e.final_at = 0;
        e.disputed_at = 0;
        e.last_nonce = 0;
        e.threshold = threshold;
        e.deadline = deadline;
        e.bump = ctx.bumps.event;
        Ok(())
    }

    /// Submit a threshold attestation. Signatures are verified by Ed25519
    /// precompile instructions in the same transaction; this handler checks
    /// that they cover exactly the domain-separated message, come from
    /// distinct non-revoked keys of the bound set, and carry a fresh nonce.
    pub fn attest(ctx: Context<Attest>, outcome: u8, observed_at: i64, nonce: u64, expires_at: i64) -> Result<()> {
        let now = now()?;
        let c = ctx.accounts.config.load()?;
        let set = &ctx.accounts.attestor_set;
        let event_key = ctx.accounts.event.key();
        let e = &mut ctx.accounts.event;
        require!(e.adapter == ADAPTER_ATTESTATION && e.binding == set.key(), MaybeError::EventMismatch);
        if set.is_dev && c.allow_dev_attestors == 0 {
            return err!(MaybeError::DevAttestorForbidden);
        }
        require!(outcome <= pl::OUTCOME_VOID, MaybeError::InvalidArgument);
        require!(now <= expires_at, MaybeError::AttestationExpired);
        require!(nonce > e.last_nonce, MaybeError::AttestationReplay);
        let msg = attest::message(attest::ATTEST_DOMAIN, &crate::ID.to_bytes(), &event_key.to_bytes(), &e.rule_hash, outcome, observed_at, nonce, expires_at);
        let signers = count_signers(&ctx.accounts.instructions, &msg, set)?;
        require!(signers >= set.threshold as usize, MaybeError::AttestationInvalid);
        e.last_nonce = nonce;
        let lazily_final = e.status == pr::STATUS_PENDING && now >= e.final_at;
        match e.status {
            pr::STATUS_OPEN => {
                e.status = pr::STATUS_PENDING;
                e.outcome = outcome;
                e.proposed_at = now;
                e.final_at = now.saturating_add(set.challenge_seconds as i64);
            }
            pr::STATUS_PENDING if lazily_final => e.status = pr::STATUS_FINAL,
            pr::STATUS_PENDING if e.outcome != outcome => {
                e.status = pr::STATUS_DISPUTED;
                e.disputed_at = now;
            }
            _ => {}
        }
        emit!(EventResolved { event: event_key, status: e.status, outcome: e.outcome, final_at: e.final_at });
        Ok(())
    }

    /// Resolve a dispute with a super-threshold of the same attestor set. Only
    /// chooses the outcome; it cannot move funds.
    pub fn adjudicate(ctx: Context<Attest>, outcome: u8, nonce: u64, expires_at: i64) -> Result<()> {
        let now = now()?;
        let c = ctx.accounts.config.load()?;
        let set = &ctx.accounts.attestor_set;
        let event_key = ctx.accounts.event.key();
        let e = &mut ctx.accounts.event;
        require!(e.adapter == ADAPTER_ATTESTATION && e.binding == set.key(), MaybeError::EventMismatch);
        if set.is_dev && c.allow_dev_attestors == 0 {
            return err!(MaybeError::DevAttestorForbidden);
        }
        require!(e.status == pr::STATUS_DISPUTED, MaybeError::InvalidEventState);
        require!(outcome <= pl::OUTCOME_VOID, MaybeError::InvalidArgument);
        require!(now <= expires_at, MaybeError::AttestationExpired);
        require!(nonce > e.last_nonce, MaybeError::AttestationReplay);
        // adjudication messages carry observed_at = 0; freshness comes from the nonce and expiry
        let msg = attest::message(attest::ADJUDICATE_DOMAIN, &crate::ID.to_bytes(), &event_key.to_bytes(), &e.rule_hash, outcome, 0, nonce, expires_at);
        let signers = count_signers(&ctx.accounts.instructions, &msg, set)?;
        require!(signers >= set.adjudication_threshold as usize, MaybeError::AttestationInvalid);
        e.last_nonce = nonce;
        e.status = pr::STATUS_FINAL;
        e.outcome = outcome;
        e.final_at = now;
        emit!(EventResolved { event: event_key, status: e.status, outcome: e.outcome, final_at: e.final_at });
        Ok(())
    }

    /// An unadjudicated dispute becomes VOID after the set's timeout.
    pub fn void_disputed(ctx: Context<TouchEvent>) -> Result<()> {
        let now = now()?;
        let set = &ctx.accounts.attestor_set;
        let key = ctx.accounts.event.key();
        let e = &mut ctx.accounts.event;
        require!(e.binding == set.key(), MaybeError::EventMismatch);
        require!(e.status == pr::STATUS_DISPUTED, MaybeError::InvalidEventState);
        require!(now >= e.disputed_at.saturating_add(set.dispute_timeout_seconds as i64), MaybeError::InvalidEventState);
        e.status = pr::STATUS_FINAL;
        e.outcome = pl::OUTCOME_VOID;
        e.final_at = now;
        emit!(EventResolved { event: key, status: e.status, outcome: e.outcome, final_at: e.final_at });
        Ok(())
    }

    /// Persist lazy finality (optional: execution already treats an elapsed challenge window as final).
    pub fn finalize_event(ctx: Context<FinalizeEvent>) -> Result<()> {
        let now = now()?;
        let key = ctx.accounts.event.key();
        let e = &mut ctx.accounts.event;
        require!(e.status == pr::STATUS_PENDING && now >= e.final_at, MaybeError::InvalidEventState);
        e.status = pr::STATUS_FINAL;
        emit!(EventResolved { event: key, status: e.status, outcome: e.outcome, final_at: e.final_at });
        Ok(())
    }

    /// Objective adapter: anyone may submit an observation of the watched token
    /// account. YES the first time balance >= threshold at or before the deadline.
    pub fn observe_balance(ctx: Context<ObserveBalance>) -> Result<()> {
        let now = now()?;
        let key = ctx.accounts.event.key();
        let watched = &ctx.accounts.watched;
        let e = &mut ctx.accounts.event;
        require!(e.adapter == ADAPTER_BALANCE && e.binding == watched.key(), MaybeError::EventMismatch);
        require!(e.status == pr::STATUS_OPEN, MaybeError::InvalidEventState);
        let t = token_info(watched)?;
        require!(t.mint == e.watched_mint.to_bytes(), MaybeError::TokenAccountMismatch);
        if now <= e.deadline {
            require!(t.amount >= e.threshold, MaybeError::ThresholdNotMet);
            e.status = pr::STATUS_FINAL;
            e.outcome = pl::OUTCOME_YES;
            e.final_at = now;
        } else {
            e.status = pr::STATUS_FINAL;
            e.outcome = pl::OUTCOME_NO;
            e.final_at = e.deadline.saturating_add(1);
        }
        emit!(EventResolved { event: key, status: e.status, outcome: e.outcome, final_at: e.final_at });
        Ok(())
    }

    // ------------------------------------------------------------ vaults
    pub fn init_vault(ctx: Context<InitVault>, vault_id: u64) -> Result<()> {
        let mut v = ctx.accounts.vault.load_init()?;
        v.owner = ctx.accounts.owner.key();
        v.vault_id = vault_id;
        v.bump = ctx.bumps.vault;
        Ok(())
    }

    /// Record the vault's canonical token account for an enabled asset (permissionless, idempotent).
    pub fn register_mint(ctx: Context<RegisterMint>) -> Result<()> {
        let c = ctx.accounts.config.load()?;
        let mint = ctx.accounts.mint.key();
        let asset = c.asset(&mint).ok_or(MaybeError::AssetNotEnabled)?;
        require!(asset.enabled == 1, MaybeError::AssetNotEnabled);
        let vault_key = ctx.accounts.vault.key();
        let ta = &ctx.accounts.vault_token_account;
        require!(ta.key() == ata_address(&vault_key, &mint, &asset.token_program), MaybeError::TokenAccountMismatch);
        require!(*ta.owner == asset.token_program, MaybeError::TokenAccountMismatch);
        let t = token_info(ta)?;
        require!(t.mint == mint.to_bytes() && t.owner == vault_key.to_bytes(), MaybeError::TokenAccountMismatch);
        let mut v = ctx.accounts.vault.load_mut()?;
        if v.entry(&mint).is_some() {
            return Ok(());
        }
        let n = v.n_balances as usize;
        require!(n < MAX_VAULT_MINTS, MaybeError::TooManyEntries);
        v.balances[n] = MintBalance { mint, token_account: ta.key(), available: 0, reserved: 0 };
        v.n_balances += 1;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, MaybeError::InvalidArgument);
        let mint = ctx.accounts.mint.key();
        let (decimals, token_program) = {
            let c = ctx.accounts.config.load()?;
            let a = c.asset(&mint).ok_or(MaybeError::AssetNotEnabled)?;
            require!(a.enabled == 1, MaybeError::AssetNotEnabled);
            (a.decimals, a.token_program)
        };
        require!(ctx.accounts.token_program.key() == token_program, MaybeError::InvalidAccount);
        let idx = {
            let v = ctx.accounts.vault.load()?;
            require!(v.owner == ctx.accounts.owner.key(), MaybeError::NotOwner);
            let i = v.entry(&mint).ok_or(MaybeError::MintNotRegistered)?;
            require!(v.balances[i].token_account == ctx.accounts.vault_token_account.key(), MaybeError::TokenAccountMismatch);
            i
        };
        let before = token_amount(&ctx.accounts.vault_token_account)?;
        transfer_checked(
            &ctx.accounts.token_program,
            &ctx.accounts.source,
            &ctx.accounts.mint,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.owner.to_account_info(),
            amount,
            decimals,
            None,
        )?;
        let after = token_amount(&ctx.accounts.vault_token_account)?;
        require!(after.checked_sub(before) == Some(amount), MaybeError::DepositMismatch);
        let mut v = ctx.accounts.vault.load_mut()?;
        v.balances[idx].available = v.balances[idx].available.checked_add(amount).ok_or(MaybeError::Overflow)?;
        emit!(Deposited { vault: ctx.accounts.vault.key(), mint, amount });
        Ok(())
    }

    /// Withdraw uncommitted funds. Owner only (never an agent session key);
    /// never blocked by the emergency pause.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, MaybeError::InvalidArgument);
        let mint = ctx.accounts.mint.key();
        let (decimals, token_program) = {
            let c = ctx.accounts.config.load()?;
            // delisted assets stay withdrawable
            let a = c.asset(&mint).ok_or(MaybeError::AssetNotEnabled)?;
            (a.decimals, a.token_program)
        };
        require!(ctx.accounts.token_program.key() == token_program, MaybeError::InvalidAccount);
        let (idx, owner, vault_id, bump) = {
            let v = ctx.accounts.vault.load()?;
            require!(v.owner == ctx.accounts.owner.key(), MaybeError::NotOwner);
            let i = v.entry(&mint).ok_or(MaybeError::MintNotRegistered)?;
            require!(v.balances[i].token_account == ctx.accounts.vault_token_account.key(), MaybeError::TokenAccountMismatch);
            require!(v.balances[i].available >= amount, MaybeError::InsufficientAvailable);
            (i, v.owner, v.vault_id, v.bump)
        };
        let (p, id, b, o) = vault_seeds_owned(&owner, vault_id, bump);
        let seeds: &[&[u8]] = &[p.as_slice(), o.as_ref(), id.as_ref(), b.as_ref()];
        transfer_checked(
            &ctx.accounts.token_program,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.mint,
            &ctx.accounts.destination,
            &ctx.accounts.vault.to_account_info(),
            amount,
            decimals,
            Some(seeds),
        )?;
        let mut v = ctx.accounts.vault.load_mut()?;
        v.balances[idx].available -= amount;
        emit!(Withdrawn { vault: ctx.accounts.vault.key(), mint, amount });
        Ok(())
    }

    // ------------------------------------------------------------ strategies
    pub fn create_strategy(ctx: Context<CreateStrategy>, strategy_id: u64, version: u32, plan_len: u16, plan_hash: [u8; 32]) -> Result<()> {
        require!((plan_len as usize) >= pl::HEADER_SIZE && (plan_len as usize) <= pl::MAX_PLAN_BYTES, MaybeError::TooLarge);
        let now = now()?;
        let creator = ctx.accounts.creator.key();
        let (owner, epoch) = {
            let v = ctx.accounts.vault.load()?;
            (v.owner, v.policy_epoch)
        };
        let mut policy_key = Pubkey::default();
        if creator != owner {
            let pol = ctx.accounts.policy.as_ref().ok_or(MaybeError::Unauthorized)?;
            let p = pol.load()?;
            require!(p.vault == ctx.accounts.vault.key() && p.session_key == creator, MaybeError::Unauthorized);
            require!(p.revoked == 0 && p.epoch == epoch && now < p.expires_at, MaybeError::PolicyRevoked);
            require!(p.can_create == 1, MaybeError::PolicyViolation);
            policy_key = pol.key();
        }
        {
            let mut v = ctx.accounts.vault.load_mut()?;
            v.strategy_count = v.strategy_count.checked_add(1).ok_or(MaybeError::Overflow)?;
        }
        let mut s = ctx.accounts.strategy.load_init()?;
        s.vault = ctx.accounts.vault.key();
        s.owner = owner;
        s.creator = creator;
        s.policy = policy_key;
        s.plan_hash = plan_hash;
        s.strategy_id = strategy_id;
        s.created_at = now;
        s.activated_at = 0;
        s.closed_at = NO_TIME;
        s.version = version;
        s.plan_len = plan_len;
        s.written = 0;
        s.status = eng::STATUS_UPLOADING;
        s.bump = ctx.bumps.strategy;
        for a in s.actions.iter_mut() {
            a.first_executed_at = NO_TIME;
            a.last_executed_at = NO_TIME;
        }
        Ok(())
    }

    pub fn write_plan(ctx: Context<WritePlan>, offset: u16, data: Vec<u8>) -> Result<()> {
        let mut s = ctx.accounts.strategy.load_mut()?;
        require!(s.creator == ctx.accounts.creator.key(), MaybeError::Unauthorized);
        require!(s.status == eng::STATUS_UPLOADING, MaybeError::StrategyClosed);
        require!(offset == s.written, MaybeError::InvalidArgument);
        let end = offset as usize + data.len();
        require!(end <= s.plan_len as usize, MaybeError::TooLarge);
        s.plan[offset as usize..end].copy_from_slice(&data);
        s.written = end as u16;
        Ok(())
    }

    /// Verify the uploaded bytes against the committed hash, validate the plan
    /// and its accounts, and move the reservation from available to reserved.
    /// Remaining accounts: every plan event in order, then every plan ref in order.
    pub fn activate_strategy<'info>(ctx: Context<'info, ActivateStrategy<'info>>) -> Result<()> {
        let now = now()?;
        let (bytes, hash, creator, policy_key) = {
            let s = ctx.accounts.strategy.load()?;
            require!(s.vault == ctx.accounts.vault.key(), MaybeError::InvalidAccount);
            require!(s.creator == ctx.accounts.creator.key(), MaybeError::Unauthorized);
            require!(s.status == eng::STATUS_UPLOADING, MaybeError::StrategyClosed);
            require!(s.written == s.plan_len, MaybeError::PlanIncomplete);
            (s.plan_bytes(), s.plan_hash, s.creator, s.policy)
        };
        let digest = solana_sha256_hasher::hash(&bytes).to_bytes();
        require!(digest == hash, MaybeError::PlanHashInvalid);
        let plan = PlanView::parse(&bytes).map_err(plan_err)?;
        let rem = ctx.remaining_accounts;
        {
            let c = ctx.accounts.config.load()?;
            eng::check_activation(&plan, now, c.max_fee_bps_cap).map_err(eng_err)?;
            for i in 0..plan.n_mints() {
                let m = Pubkey::new_from_array(plan.mint(i));
                let a = c.asset(&m).ok_or(MaybeError::MintNotAllowed)?;
                require!(a.enabled == 1, MaybeError::MintNotAllowed);
            }
            require!(rem.len() >= plan.n_events() + plan.n_refs(), MaybeError::InvalidAccount);
            for i in 0..plan.n_events() {
                require!(rem[i].key.to_bytes() == plan.event(i), MaybeError::EventMismatch);
                let _e: Account<OutcomeEvent> = Account::try_from(&rem[i])?;
            }
            for r in 0..plan.n_refs() {
                let acc = &rem[plan.n_events() + r];
                require!(acc.key.to_bytes() == plan.r#ref(r), MaybeError::InvalidAccount);
                for ai in 0..plan.n_actions() {
                    let a = plan.action(ai);
                    if a.kind == pl::KIND_SWAP && a.r#ref as usize == r {
                        let route = c.route(a.route_kind).ok_or(MaybeError::RouteNotEnabled)?;
                        require!(route.enabled == 1, MaybeError::RouteNotEnabled);
                        require!(*acc.owner == route.program_id, MaybeError::RouteAccountMismatch);
                    }
                }
                if receipt_refs(&plan).contains(&(r as u8)) {
                    let _s: AccountLoader<Strategy> = AccountLoader::try_from(acc)?;
                }
            }
        }
        let reservation = eng::reservation_by_mint(&plan).map_err(eng_err)?;
        {
            let mut v = ctx.accounts.vault.load_mut()?;
            for i in 0..plan.n_mints() {
                if reservation[i] == 0 {
                    continue;
                }
                let m = Pubkey::new_from_array(plan.mint(i));
                let e = v.entry(&m).ok_or(MaybeError::MintNotRegistered)?;
                let b = &mut v.balances[e];
                require!(b.available >= reservation[i], MaybeError::InsufficientAvailable);
                b.available -= reservation[i];
                b.reserved = b.reserved.checked_add(reservation[i]).ok_or(MaybeError::Overflow)?;
            }
            // every plan mint needs a vault token account (swap outputs land there)
            for i in 0..plan.n_mints() {
                let m = Pubkey::new_from_array(plan.mint(i));
                require!(v.entry(&m).is_some(), MaybeError::MintNotRegistered);
            }
            if policy_key != Pubkey::default() {
                let pol = ctx.accounts.policy.as_ref().ok_or(MaybeError::Unauthorized)?;
                require!(pol.key() == policy_key, MaybeError::Unauthorized);
                let mut p = pol.load_mut()?;
                require!(p.session_key == creator, MaybeError::Unauthorized);
                let mints: Vec<[u8; 32]> = p.allowed_mints[..p.n_mints as usize].iter().map(|k| k.to_bytes()).collect();
                let routes: Vec<[u8; 32]> = p.allowed_routes[..p.n_routes as usize].iter().map(|k| k.to_bytes()).collect();
                let recips: Vec<[u8; 32]> = p.allowed_recipients[..p.n_recipients as usize].iter().map(|k| k.to_bytes()).collect();
                let view = po::PolicyView {
                    revoked: p.revoked != 0,
                    epoch: p.epoch,
                    vault_epoch: v.policy_epoch,
                    expires_at: p.expires_at,
                    can_create: p.can_create != 0,
                    max_fee_bps: p.max_fee_bps,
                    allowed_mints: &mints,
                    allowed_routes: &routes,
                    allowed_recipients: &recips,
                    max_total: &p.max_total[..p.n_mints as usize],
                    max_per_action: &p.max_per_action[..p.n_mints as usize],
                    spent: &p.spent[..p.n_mints as usize],
                };
                let add = po::check_policy(&plan, &view, now).map_err(policy_err)?;
                for slot in 0..p.n_mints as usize {
                    p.spent[slot] = p.spent[slot].checked_add(add[slot]).ok_or(MaybeError::Overflow)?;
                }
            }
        }
        let rt = eng::Runtime::activated(&plan, now);
        let mut s = ctx.accounts.strategy.load_mut()?;
        s.store(&rt);
        emit!(StrategyActivated { strategy: ctx.accounts.strategy.key(), vault: ctx.accounts.vault.key(), plan_hash: hash, reserved: reservation, by_policy: policy_key != Pubkey::default() });
        Ok(())
    }

    /// Permissionless crank. Executes run `run` of action `action` only if the
    /// committed plan allows it right now. Remaining accounts: plan events in
    /// order, receipt-referenced strategies (ascending ref index), then the
    /// action accounts documented in docs/INTERFACE_CONTRACT.md §6.
    pub fn execute_action<'info>(ctx: Context<'info, ExecuteAction<'info>>, action: u8, run: u16, expected_plan_hash: [u8; 32]) -> Result<()> {
        let now = now()?;
        let i = action as usize;
        let paused = ctx.accounts.config.load()?.paused_execution != 0;
        let (bytes, mut rt, strategy_key) = {
            let s = ctx.accounts.strategy.load()?;
            require!(s.vault == ctx.accounts.vault.key(), MaybeError::InvalidAccount);
            require!(s.plan_hash == expected_plan_hash, MaybeError::PlanHashMismatch);
            require!(s.status != eng::STATUS_UPLOADING, MaybeError::NotActive);
            (s.plan_bytes(), s.runtime(), ctx.accounts.strategy.key())
        };
        let plan = PlanView::parse(&bytes).map_err(plan_err)?;
        require!(i < plan.n_actions(), MaybeError::BadPlan);
        let rem = ctx.remaining_accounts;
        let (events, ext, next) = load_context(&plan, rem)?;
        let times = {
            let env = Env { now, plan: &plan, rt: &rt, events, ext };
            pr::evaluate_nodes(&plan, &env)
        };
        let prep = eng::prepare(&plan, &rt, i, &times, now, paused, Some(run)).map_err(eng_err)?;
        let a = plan.action(i);
        let in_mint = Pubkey::new_from_array(plan.mint(a.in_mint as usize));
        let out_mint = if a.kind == pl::KIND_SWAP { Pubkey::new_from_array(plan.mint(a.out_mint as usize)) } else { Pubkey::default() };
        let acc = &rem[next..];
        let (owner, vault_id, bump, in_entry, out_entry) = {
            let v = ctx.accounts.vault.load()?;
            let ie = v.entry(&in_mint).ok_or(MaybeError::MintNotRegistered)?;
            let oe = if a.kind == pl::KIND_SWAP { Some(v.entry(&out_mint).ok_or(MaybeError::MintNotRegistered)?) } else { None };
            (v.owner, v.vault_id, v.bump, (ie, v.balances[ie].token_account), oe.map(|o| (o, v.balances[o].token_account)))
        };
        let (in_asset_tp, in_decimals, in_treasury) = {
            let c = ctx.accounts.config.load()?;
            let asset = c.asset(&in_mint).ok_or(MaybeError::AssetNotEnabled)?;
            (asset.token_program, asset.decimals, asset.treasury)
        };
        let vault_info = ctx.accounts.vault.to_account_info();
        let vault_key = vault_info.key();
        let (p, id, b, o) = vault_seeds_owned(&owner, vault_id, bump);
        let seeds: &[&[u8]] = &[p.as_slice(), o.as_ref(), id.as_ref(), b.as_ref()];
        let mut recipient = Pubkey::default();

        let effects = match a.kind {
            pl::KIND_SWAP => {
                let (route_program, slice_len) = match a.route_kind {
                    pl::ROUTE_CP_SWAP => (acc.first(), 11usize),
                    pl::ROUTE_OUTCOME_BUY => (acc.first(), 9usize),
                    _ => (acc.first(), 10usize),
                };
                require!(acc.len() >= slice_len, MaybeError::InvalidAccount);
                let route_program = route_program.ok_or(MaybeError::InvalidAccount)?;
                {
                    let c = ctx.accounts.config.load()?;
                    let route = c.route(a.route_kind).ok_or(MaybeError::RouteNotEnabled)?;
                    require!(route.enabled == 1 && route.program_id == route_program.key(), MaybeError::RouteNotEnabled);
                    let out_asset = c.asset(&out_mint).ok_or(MaybeError::AssetNotEnabled)?;
                    let _ = out_asset;
                }
                let pool = &acc[1];
                require!(pool.key.to_bytes() == plan.r#ref(a.r#ref as usize), MaybeError::RouteAccountMismatch);
                require!(*pool.owner == route_program.key(), MaybeError::RouteAccountMismatch);
                // positions of vault src/dst and the venue-facing slice (venue order, without user accounts)
                let (venue_accounts, src, dst, treasury): (&[AccountInfo<'info>], &AccountInfo<'info>, &AccountInfo<'info>, &AccountInfo<'info>) = match a.route_kind {
                    // [program, pool, mint_a, mint_b, pool_vault_a, pool_vault_b, token_program_a, token_program_b, src, dst, treasury]
                    pl::ROUTE_CP_SWAP => (&acc[1..8], &acc[8], &acc[9], &acc[10]),
                    // [program, market, collateral_mint, yes_mint, market_vault, token_program, src, dst, treasury]
                    pl::ROUTE_OUTCOME_BUY => (&acc[1..6], &acc[6], &acc[7], &acc[8]),
                    // [program, market, event, collateral_mint, yes_mint, market_vault, token_program, src, dst, treasury]
                    _ => (&acc[1..7], &acc[7], &acc[8], &acc[9]),
                };
                require!(src.key() == in_entry.1, MaybeError::TokenAccountMismatch);
                require!(dst.key() == out_entry.ok_or(MaybeError::MintNotRegistered)?.1, MaybeError::TokenAccountMismatch);
                require!(treasury.key() == in_treasury, MaybeError::TokenAccountMismatch);
                // mints used by the venue must be exactly this pair
                let pair_ok = match a.route_kind {
                    pl::ROUTE_CP_SWAP => {
                        let (ma, mb) = (venue_accounts[1].key(), venue_accounts[2].key());
                        (ma == in_mint && mb == out_mint) || (ma == out_mint && mb == in_mint)
                    }
                    pl::ROUTE_OUTCOME_BUY => venue_accounts[1].key() == in_mint && venue_accounts[2].key() == out_mint,
                    _ => venue_accounts[2].key() == out_mint && venue_accounts[3].key() == in_mint,
                };
                require!(pair_ok, MaybeError::RouteAccountMismatch);
                // no vault-owned token account may appear anywhere in the route slice except src/dst
                for x in venue_accounts.iter() {
                    if is_token_program(x.owner) && x.data_len() >= tk::ACCOUNT_BASE_LEN {
                        let data = x.try_borrow_data()?;
                        if let Ok(t) = tk::parse_token_account(&data) {
                            require!(t.owner != vault_key.to_bytes(), MaybeError::ForeignVaultAccountInRoute);
                        }
                    }
                }
                let src_before = token_amount(src)?;
                let dst_before = token_amount(dst)?;
                let min_out = u64::try_from(prep.min_out).unwrap_or(u64::MAX);
                let (name, user_pos): (&[u8], usize) = match a.route_kind {
                    pl::ROUTE_CP_SWAP => (b"global:swap", 5),
                    pl::ROUTE_OUTCOME_BUY => (b"global:buy_yes", 4),
                    _ => (b"global:redeem", 5),
                };
                let disc = solana_sha256_hasher::hash(name).to_bytes();
                let mut data = Vec::with_capacity(24);
                data.extend_from_slice(&disc[..8]);
                data.extend_from_slice(&prep.amount_in.to_le_bytes());
                data.extend_from_slice(&min_out.to_le_bytes());
                // venue order: venue_accounts[..user_pos] ++ [user_src, user_dst, user_authority] ++ venue_accounts[user_pos..]
                let mut metas = Vec::with_capacity(venue_accounts.len() + 3);
                let mut infos = Vec::with_capacity(venue_accounts.len() + 4);
                let push = |metas: &mut Vec<AccountMeta>, infos: &mut Vec<AccountInfo<'info>>, x: &AccountInfo<'info>| {
                    metas.push(if x.is_writable { AccountMeta::new(*x.key, false) } else { AccountMeta::new_readonly(*x.key, false) });
                    infos.push(x.clone());
                };
                for x in &venue_accounts[..user_pos] {
                    push(&mut metas, &mut infos, x);
                }
                metas.push(AccountMeta::new(src.key(), false));
                infos.push(src.clone());
                metas.push(AccountMeta::new(dst.key(), false));
                infos.push(dst.clone());
                metas.push(AccountMeta::new_readonly(vault_key, true));
                infos.push(vault_info.clone());
                for x in &venue_accounts[user_pos..] {
                    push(&mut metas, &mut infos, x);
                }
                infos.push(route_program.clone());
                let ix = Instruction { program_id: route_program.key(), accounts: metas, data };
                invoke_signed(&ix, &infos, &[seeds])?;
                let src_after = token_amount(src)?;
                let dst_after = token_amount(dst)?;
                let spent_in = src_before.checked_sub(src_after).ok_or(MaybeError::RouteDeltaViolation)?;
                let received_out = dst_after.checked_sub(dst_before).ok_or(MaybeError::RouteDeltaViolation)?;
                let eff = eng::settle_swap(&plan, &prep, spent_in, received_out).map_err(eng_err)?;
                if eff.fee > 0 {
                    let mint_info = match a.route_kind {
                        pl::ROUTE_CP_SWAP => {
                            if venue_accounts[1].key() == in_mint {
                                &venue_accounts[1]
                            } else {
                                &venue_accounts[2]
                            }
                        }
                        pl::ROUTE_OUTCOME_BUY => &venue_accounts[1],
                        _ => &venue_accounts[3],
                    };
                    let tp = venue_accounts.iter().find(|x| x.key() == in_asset_tp).ok_or(MaybeError::InvalidAccount)?;
                    transfer_checked(tp, src, mint_info, treasury, &vault_info, eff.fee, in_decimals, Some(seeds))?;
                }
                eff
            }
            pl::KIND_TRANSFER => {
                // [src, mint, recipient_token_account, token_program, treasury]
                require!(acc.len() >= 5, MaybeError::InvalidAccount);
                let (src, mint, dest, tp, treasury) = (&acc[0], &acc[1], &acc[2], &acc[3], &acc[4]);
                require!(src.key() == in_entry.1 && mint.key() == in_mint, MaybeError::TokenAccountMismatch);
                require!(tp.key() == in_asset_tp, MaybeError::InvalidAccount);
                recipient = Pubkey::new_from_array(plan.r#ref(a.r#ref as usize));
                let d = token_info(dest)?;
                require!(d.mint == in_mint.to_bytes() && d.owner == recipient.to_bytes(), MaybeError::TokenAccountMismatch);
                let eff = eng::settle_direct(&plan, &prep);
                transfer_checked(tp, src, mint, dest, &vault_info, eff.amount_in, in_decimals, Some(seeds))?;
                if eff.fee > 0 {
                    require!(treasury.key() == in_treasury, MaybeError::TokenAccountMismatch);
                    transfer_checked(tp, src, mint, treasury, &vault_info, eff.fee, in_decimals, Some(seeds))?;
                }
                eff
            }
            _ => eng::settle_direct(&plan, &prep),
        };

        eng::apply(&plan, &mut rt, &effects, now).map_err(eng_err)?;
        {
            let mut v = ctx.accounts.vault.load_mut()?;
            let ie = in_entry.0;
            v.balances[ie].reserved = v.balances[ie].reserved.checked_sub(effects.taken).ok_or(MaybeError::InsufficientAllocation)?;
            if a.kind == pl::KIND_RELEASE {
                v.balances[ie].available = v.balances[ie].available.checked_add(effects.taken).ok_or(MaybeError::Overflow)?;
            }
            if let (pl::KIND_SWAP, Some((oe, _))) = (a.kind, out_entry) {
                v.balances[oe].reserved = v.balances[oe].reserved.checked_add(effects.amount_out).ok_or(MaybeError::Overflow)?;
            }
        }
        ctx.accounts.strategy.load_mut()?.store(&rt);
        emit!(ExecutionReceipt {
            strategy: strategy_key,
            plan_hash: expected_plan_hash,
            action,
            run: effects.run,
            skipped_runs: effects.skipped_runs,
            exec_nonce: rt.exec_nonce,
            at: now,
            kind: a.kind,
            in_mint,
            out_mint,
            amount: effects.taken,
            fee: effects.fee,
            amount_in: effects.amount_in,
            amount_out: effects.amount_out,
            recipient,
        });
        Ok(())
    }

    pub fn pause_strategy(ctx: Context<OwnerStrategy>, paused: bool) -> Result<()> {
        let mut s = ctx.accounts.strategy.load_mut()?;
        require!(s.owner == ctx.accounts.owner.key(), MaybeError::NotOwner);
        require!(s.vault == ctx.accounts.vault.key(), MaybeError::InvalidAccount);
        require!(s.status == eng::STATUS_ACTIVE || s.status == eng::STATUS_PAUSED, MaybeError::StrategyClosed);
        s.status = if paused { eng::STATUS_PAUSED } else { eng::STATUS_ACTIVE };
        Ok(())
    }

    pub fn cancel_strategy<'info>(ctx: Context<'info, OwnerStrategy<'info>>) -> Result<()> {
        let signer = ctx.accounts.owner.key();
        close_impl(&ctx.accounts.vault, &ctx.accounts.strategy, eng::CLOSE_CANCEL, Some(signer), &[])
    }

    pub fn close_expired<'info>(ctx: Context<'info, CloseStrategy<'info>>) -> Result<()> {
        close_impl(&ctx.accounts.vault, &ctx.accounts.strategy, eng::CLOSE_EXPIRE, None, &[])
    }

    /// Remaining accounts: plan events in order, then receipt-referenced strategies.
    pub fn close_completed<'info>(ctx: Context<'info, CloseStrategy<'info>>) -> Result<()> {
        close_impl(&ctx.accounts.vault, &ctx.accounts.strategy, eng::CLOSE_COMPLETE, None, ctx.remaining_accounts)
    }

    // ------------------------------------------------------------ agent policies
    pub fn create_policy(ctx: Context<CreatePolicy>, args: PolicyArgs) -> Result<()> {
        let epoch = {
            let v = ctx.accounts.vault.load()?;
            require!(v.owner == ctx.accounts.owner.key(), MaybeError::NotOwner);
            v.policy_epoch
        };
        require!(args.mints.len() <= MAX_POLICY_MINTS && args.mints.len() == args.max_total.len() && args.mints.len() == args.max_per_action.len(), MaybeError::InvalidArgument);
        require!(args.routes.len() <= MAX_POLICY_ROUTES && args.recipients.len() <= MAX_POLICY_RECIPIENTS, MaybeError::InvalidArgument);
        require!(args.max_fee_bps <= pl::MAX_FEE_BPS && args.expires_at > now()?, MaybeError::InvalidArgument);
        let mut p = ctx.accounts.policy.load_init()?;
        p.vault = ctx.accounts.vault.key();
        p.owner = ctx.accounts.owner.key();
        p.session_key = ctx.accounts.session_key.key();
        p.allowed_mints[..args.mints.len()].copy_from_slice(&args.mints);
        p.allowed_routes[..args.routes.len()].copy_from_slice(&args.routes);
        p.allowed_recipients[..args.recipients.len()].copy_from_slice(&args.recipients);
        p.max_total[..args.mints.len()].copy_from_slice(&args.max_total);
        p.max_per_action[..args.mints.len()].copy_from_slice(&args.max_per_action);
        p.n_mints = args.mints.len() as u8;
        p.n_routes = args.routes.len() as u8;
        p.n_recipients = args.recipients.len() as u8;
        p.max_fee_bps = args.max_fee_bps;
        p.expires_at = args.expires_at;
        p.epoch = epoch;
        p.can_create = args.can_create as u8;
        p.can_cancel = 0;
        p.revoked = 0;
        p.bump = ctx.bumps.policy;
        emit!(PolicyChanged { policy: ctx.accounts.policy.key(), revoked: false, epoch });
        Ok(())
    }

    pub fn revoke_policy(ctx: Context<RevokePolicy>) -> Result<()> {
        let mut p = ctx.accounts.policy.load_mut()?;
        require!(p.owner == ctx.accounts.owner.key(), MaybeError::NotOwner);
        p.revoked = 1;
        emit!(PolicyChanged { policy: ctx.accounts.policy.key(), revoked: true, epoch: p.epoch });
        Ok(())
    }

    /// Kill switch: voids every agent policy of this vault at once. Withdrawals unaffected.
    pub fn kill_switch(ctx: Context<KillSwitch>) -> Result<()> {
        let mut v = ctx.accounts.vault.load_mut()?;
        require!(v.owner == ctx.accounts.owner.key(), MaybeError::NotOwner);
        v.policy_epoch = v.policy_epoch.checked_add(1).ok_or(MaybeError::Overflow)?;
        emit!(PolicyChanged { policy: Pubkey::default(), revoked: true, epoch: v.policy_epoch });
        Ok(())
    }
}

fn close_impl<'info>(vault: &AccountLoader<'info, Vault>, strategy: &AccountLoader<'info, Strategy>, mode: u8, signer: Option<Pubkey>, rem: &'info [AccountInfo<'info>]) -> Result<()> {
    let now = now()?;
    let (bytes, mut rt, owner) = {
        let s = strategy.load()?;
        require!(s.vault == vault.key(), MaybeError::InvalidAccount);
        (s.plan_bytes(), s.runtime(), s.owner)
    };
    let plan = PlanView::parse(&bytes).map_err(plan_err)?;
    let times = if mode == eng::CLOSE_COMPLETE {
        let (events, ext, _) = load_context(&plan, rem)?;
        let env = Env { now, plan: &plan, rt: &rt, events, ext };
        pr::evaluate_nodes(&plan, &env)
    } else {
        [pr::PENDING_TIMES; pl::MAX_NODES]
    };
    let refunds = eng::close(&plan, &mut rt, mode, now, signer == Some(owner), &times).map_err(eng_err)?;
    {
        let mut v = vault.load_mut()?;
        for (i, amt) in refunds.iter().enumerate().take(plan.n_mints()) {
            if *amt == 0 {
                continue;
            }
            let m = Pubkey::new_from_array(plan.mint(i));
            let e = v.entry(&m).ok_or(MaybeError::MintNotRegistered)?;
            let b = &mut v.balances[e];
            b.reserved = b.reserved.checked_sub(*amt).ok_or(MaybeError::Overflow)?;
            b.available = b.available.checked_add(*amt).ok_or(MaybeError::Overflow)?;
        }
    }
    strategy.load_mut()?.store(&rt);
    emit!(StrategyClosed { strategy: strategy.key(), mode, refunded: refunds });
    Ok(())
}

fn count_signers(instructions: &AccountInfo, expected: &[u8], set: &AttestorSet) -> Result<usize> {
    let allowed: Vec<[u8; 32]> = set.keys[..set.n_keys as usize].iter().map(|k| k.to_bytes()).collect();
    let mut entries_owned: Vec<([u8; 32], Vec<u8>)> = Vec::new();
    let mut idx: usize = 0;
    while let Ok(ix) = load_instruction_at_checked(idx, instructions) {
        if ix.program_id == ED25519_PROGRAM_ID {
            let parsed = attest::parse_ed25519(&ix.data).map_err(|_| MaybeError::AttestationInvalid)?;
            for (pk, m) in parsed {
                entries_owned.push((pk, m.to_vec()));
            }
        }
        idx += 1;
        if idx > 32 {
            break;
        }
    }
    let entries: Vec<([u8; 32], &[u8])> = entries_owned.iter().map(|(k, m)| (*k, m.as_slice())).collect();
    Ok(attest::count_valid_signers(&entries, expected, &allowed, set.revoked))
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PolicyArgs {
    pub mints: Vec<Pubkey>,
    pub max_total: Vec<u64>,
    pub max_per_action: Vec<u64>,
    pub routes: Vec<Pubkey>,
    pub recipients: Vec<Pubkey>,
    pub max_fee_bps: u16,
    pub expires_at: i64,
    pub can_create: bool,
}

// ---------------------------------------------------------------- contexts
#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + std::mem::size_of::<Config>(), seeds = [b"config"], bump)]
    pub config: AccountLoader<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump, constraint = config.load()?.admin == admin.key() @ MaybeError::Unauthorized)]
    pub config: AccountLoader<'info, Config>,
}

#[derive(Accounts)]
pub struct SetAsset<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump, constraint = config.load()?.admin == admin.key() @ MaybeError::Unauthorized)]
    pub config: AccountLoader<'info, Config>,
    /// CHECK: validated in handler (owner = token program, extension allowlist)
    pub mint: UncheckedAccount<'info>,
    /// CHECK: validated in handler (token account of `mint`)
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(set_id: u64)]
pub struct InitAttestorSet<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump, constraint = config.load()?.admin == admin.key() @ MaybeError::Unauthorized)]
    pub config: AccountLoader<'info, Config>,
    #[account(init, payer = admin, space = 8 + AttestorSet::INIT_SPACE, seeds = [b"attestors", set_id.to_le_bytes().as_ref()], bump)]
    pub attestor_set: Account<'info, AttestorSet>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeAttestor<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump, constraint = config.load()?.admin == admin.key() @ MaybeError::Unauthorized)]
    pub config: AccountLoader<'info, Config>,
    #[account(mut)]
    pub attestor_set: Account<'info, AttestorSet>,
}

#[derive(Accounts)]
#[instruction(adapter: u8, venue: u8, market_id_hash: [u8; 32], rule_hash: [u8; 32])]
pub struct CreateEvent<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + OutcomeEvent::INIT_SPACE,
        seeds = [b"event", adapter.to_le_bytes().as_ref(), market_id_hash.as_ref(), rule_hash.as_ref(), binding.key().as_ref()],
        bump
    )]
    pub event: Account<'info, OutcomeEvent>,
    /// CHECK: attestor set (attestation) or watched token account (balance); validated in handler
    pub binding: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Attest<'info> {
    #[account(mut)]
    pub event: Account<'info, OutcomeEvent>,
    pub attestor_set: Account<'info, AttestorSet>,
    #[account(seeds = [b"config"], bump)]
    pub config: AccountLoader<'info, Config>,
    /// CHECK: instructions sysvar
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct TouchEvent<'info> {
    #[account(mut)]
    pub event: Account<'info, OutcomeEvent>,
    pub attestor_set: Account<'info, AttestorSet>,
}

#[derive(Accounts)]
pub struct FinalizeEvent<'info> {
    #[account(mut)]
    pub event: Account<'info, OutcomeEvent>,
}

#[derive(Accounts)]
pub struct ObserveBalance<'info> {
    #[account(mut)]
    pub event: Account<'info, OutcomeEvent>,
    /// CHECK: must equal event.binding; parsed as a token account
    pub watched: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + std::mem::size_of::<Vault>(), seeds = [b"vault", owner.key().as_ref(), vault_id.to_le_bytes().as_ref()], bump)]
    pub vault: AccountLoader<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterMint<'info> {
    #[account(seeds = [b"config"], bump)]
    pub config: AccountLoader<'info, Config>,
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    /// CHECK: listed asset (checked against config)
    pub mint: UncheckedAccount<'info>,
    /// CHECK: must be ATA(vault, mint, token_program)
    pub vault_token_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: AccountLoader<'info, Config>,
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    /// CHECK: listed asset
    pub mint: UncheckedAccount<'info>,
    /// CHECK: owner's token account (token program enforces authority)
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: vault's registered token account
    #[account(mut)]
    pub vault_token_account: UncheckedAccount<'info>,
    /// CHECK: must equal the asset's token program
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: AccountLoader<'info, Config>,
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    /// CHECK: listed asset
    pub mint: UncheckedAccount<'info>,
    /// CHECK: vault's registered token account
    #[account(mut)]
    pub vault_token_account: UncheckedAccount<'info>,
    /// CHECK: any token account the owner chooses
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: must equal the asset's token program
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(strategy_id: u64)]
pub struct CreateStrategy<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    #[account(init, payer = creator, space = 8 + std::mem::size_of::<Strategy>(), seeds = [b"strategy", vault.key().as_ref(), strategy_id.to_le_bytes().as_ref()], bump)]
    pub strategy: AccountLoader<'info, Strategy>,
    pub policy: Option<AccountLoader<'info, Policy>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WritePlan<'info> {
    pub creator: Signer<'info>,
    #[account(mut)]
    pub strategy: AccountLoader<'info, Strategy>,
}

#[derive(Accounts)]
pub struct ActivateStrategy<'info> {
    pub creator: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: AccountLoader<'info, Config>,
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    #[account(mut)]
    pub strategy: AccountLoader<'info, Strategy>,
    #[account(mut)]
    pub policy: Option<AccountLoader<'info, Policy>>,
}

#[derive(Accounts)]
pub struct ExecuteAction<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: AccountLoader<'info, Config>,
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    #[account(mut)]
    pub strategy: AccountLoader<'info, Strategy>,
}

#[derive(Accounts)]
pub struct OwnerStrategy<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    #[account(mut)]
    pub strategy: AccountLoader<'info, Strategy>,
}

#[derive(Accounts)]
pub struct CloseStrategy<'info> {
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
    #[account(mut)]
    pub strategy: AccountLoader<'info, Strategy>,
}

#[derive(Accounts)]
pub struct CreatePolicy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub vault: AccountLoader<'info, Vault>,
    /// CHECK: the agent's session public key (holds no authority except via this policy)
    pub session_key: UncheckedAccount<'info>,
    #[account(init, payer = owner, space = 8 + std::mem::size_of::<Policy>(), seeds = [b"policy", vault.key().as_ref(), session_key.key().as_ref()], bump)]
    pub policy: AccountLoader<'info, Policy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokePolicy<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub policy: AccountLoader<'info, Policy>,
}

#[derive(Accounts)]
pub struct KillSwitch<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub vault: AccountLoader<'info, Vault>,
}
