//! maybe_testvenue — LOCAL TEST VENUE ONLY. Never deploy outside localnet.
//!
//! * Constant-product pools (same math as packages/core/src/venue.ts) so the
//!   vault has a real program-controlled swap route on solana-test-validator.
//! * A binary outcome market bound to a maybe_vault OutcomeEvent: buy YES at a
//!   fixed price, redeem after finality (YES 1:1, VOID at the purchase price).
//! * Switchable misbehaviour per pool so tests can prove the vault rejects a
//!   malicious allowlisted route: overspend, underdeliver, redirect, touch_other.
#![allow(unexpected_cfgs)]
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use maybe_logic::tokens as tk;
use maybe_vault::state::OutcomeEvent;

declare_id!("4Na5xvms9PXcE7KYq97juhzznM9jsKQ5dgSJxfR4pHDJ");

pub const MODE_HONEST: u8 = 0;
pub const MODE_OVERSPEND: u8 = 1;
pub const MODE_UNDERDELIVER: u8 = 2;
pub const MODE_REDIRECT: u8 = 3;
pub const MODE_TOUCH_OTHER: u8 = 4;

const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

#[error_code]
pub enum VenueError {
    InvalidAccount,
    SlippageExceeded,
    NotSettled,
    LosingOutcome,
    InvalidArgument,
}

fn token(acc: &AccountInfo) -> Result<tk::TokenAccountInfo> {
    require!(*acc.owner == TOKEN_PROGRAM_ID || *acc.owner == TOKEN_2022_PROGRAM_ID, VenueError::InvalidAccount);
    let d = acc.try_borrow_data()?;
    tk::parse_token_account(&d).map_err(|_| error!(VenueError::InvalidAccount))
}

fn mint_decimals(acc: &AccountInfo) -> Result<u8> {
    let d = acc.try_borrow_data()?;
    require!(d.len() >= 82, VenueError::InvalidAccount);
    Ok(d[44])
}

#[allow(clippy::too_many_arguments)]
fn tc<'info>(tp: &AccountInfo<'info>, from: &AccountInfo<'info>, mint: &AccountInfo<'info>, to: &AccountInfo<'info>, auth: &AccountInfo<'info>, amount: u64, dec: u8, seeds: Option<&[&[u8]]>) -> Result<()> {
    let ix = Instruction {
        program_id: *tp.key,
        accounts: vec![AccountMeta::new(*from.key, false), AccountMeta::new_readonly(*mint.key, false), AccountMeta::new(*to.key, false), AccountMeta::new_readonly(*auth.key, true)],
        data: tk::transfer_checked_data(amount, dec).to_vec(),
    };
    let infos = [from.clone(), mint.clone(), to.clone(), auth.clone(), tp.clone()];
    match seeds {
        Some(s) => invoke_signed(&ix, &infos, &[s])?,
        None => invoke(&ix, &infos)?,
    }
    Ok(())
}

pub fn cp_out(rin: u64, rout: u64, amount_in: u64, fee_bps: u16) -> u64 {
    let in_after_fee = (amount_in as u128 * (10_000 - fee_bps as u128)) / 10_000;
    if in_after_fee == 0 {
        return 0;
    }
    ((rout as u128 * in_after_fee) / (rin as u128 + in_after_fee)) as u64
}

#[program]
pub mod maybe_testvenue {
    use super::*;

    pub fn init_pool(ctx: Context<InitPool>, pool_id: u64, fee_bps: u16, mode: u8) -> Result<()> {
        require!(fee_bps < 10_000 && mode <= MODE_TOUCH_OTHER, VenueError::InvalidArgument);
        let pool_key = ctx.accounts.pool.key();
        let va = token(&ctx.accounts.vault_a)?;
        let vb = token(&ctx.accounts.vault_b)?;
        require!(va.mint == ctx.accounts.mint_a.key().to_bytes() && va.owner == pool_key.to_bytes(), VenueError::InvalidAccount);
        require!(vb.mint == ctx.accounts.mint_b.key().to_bytes() && vb.owner == pool_key.to_bytes(), VenueError::InvalidAccount);
        require!(*ctx.accounts.vault_a.owner == ctx.accounts.token_program_a.key() && *ctx.accounts.vault_b.owner == ctx.accounts.token_program_b.key(), VenueError::InvalidAccount);
        let p = &mut ctx.accounts.pool;
        p.pool_id = pool_id;
        p.admin = ctx.accounts.admin.key();
        p.mint_a = ctx.accounts.mint_a.key();
        p.mint_b = ctx.accounts.mint_b.key();
        p.vault_a = ctx.accounts.vault_a.key();
        p.vault_b = ctx.accounts.vault_b.key();
        p.token_program_a = ctx.accounts.token_program_a.key();
        p.token_program_b = ctx.accounts.token_program_b.key();
        p.decimals_a = mint_decimals(&ctx.accounts.mint_a)?;
        p.decimals_b = mint_decimals(&ctx.accounts.mint_b)?;
        p.fee_bps = fee_bps;
        p.mode = mode;
        p.bump = ctx.bumps.pool;
        Ok(())
    }

    pub fn add_liquidity(ctx: Context<AddLiquidity>, amount_a: u64, amount_b: u64) -> Result<()> {
        let p = &ctx.accounts.pool;
        require!(ctx.accounts.vault_a.key() == p.vault_a && ctx.accounts.vault_b.key() == p.vault_b, VenueError::InvalidAccount);
        let auth = ctx.accounts.provider.to_account_info();
        if amount_a > 0 {
            tc(&ctx.accounts.token_program_a, &ctx.accounts.src_a, &ctx.accounts.mint_a, &ctx.accounts.vault_a, &auth, amount_a, p.decimals_a, None)?;
        }
        if amount_b > 0 {
            tc(&ctx.accounts.token_program_b, &ctx.accounts.src_b, &ctx.accounts.mint_b, &ctx.accounts.vault_b, &auth, amount_b, p.decimals_b, None)?;
        }
        Ok(())
    }

    /// Swap `amount_in` of user_src's mint for the other side, delivering at least `min_out`.
    pub fn swap<'info>(ctx: Context<'info, Swap<'info>>, amount_in: u64, min_out: u64) -> Result<()> {
        let p = &ctx.accounts.pool;
        let mode = p.mode;
        require!(ctx.accounts.mint_a.key() == p.mint_a && ctx.accounts.mint_b.key() == p.mint_b, VenueError::InvalidAccount);
        if mode != MODE_TOUCH_OTHER {
            require!(ctx.accounts.vault_a.key() == p.vault_a && ctx.accounts.vault_b.key() == p.vault_b, VenueError::InvalidAccount);
        }
        let src = token(&ctx.accounts.user_src)?;
        let a_to_b = src.mint == p.mint_a.to_bytes();
        require!(a_to_b || src.mint == p.mint_b.to_bytes(), VenueError::InvalidAccount);
        let (vin, vout, min_acc, mout_acc, tpin, tpout, din, dout) = if a_to_b {
            (&ctx.accounts.vault_a, &ctx.accounts.vault_b, &ctx.accounts.mint_a, &ctx.accounts.mint_b, &ctx.accounts.token_program_a, &ctx.accounts.token_program_b, p.decimals_a, p.decimals_b)
        } else {
            (&ctx.accounts.vault_b, &ctx.accounts.vault_a, &ctx.accounts.mint_b, &ctx.accounts.mint_a, &ctx.accounts.token_program_b, &ctx.accounts.token_program_a, p.decimals_b, p.decimals_a)
        };
        let rin = token(vin)?.amount;
        let rout = token(vout)?.amount;
        let out = cp_out(rin, rout, amount_in, p.fee_bps);
        let user = ctx.accounts.user_authority.to_account_info();
        let pool_id = p.pool_id.to_le_bytes();
        let bump = [p.bump];
        let seeds: &[&[u8]] = &[b"pool", pool_id.as_ref(), bump.as_ref()];
        let pool_info = ctx.accounts.pool.to_account_info();
        let pull = if mode == MODE_OVERSPEND { amount_in + 1 } else { amount_in };
        tc(tpin, &ctx.accounts.user_src, min_acc, vin, &user, pull, din, None)?;
        let deliver = match mode {
            MODE_UNDERDELIVER => out / 2,
            MODE_REDIRECT => 0,
            _ => {
                require!(out >= min_out, VenueError::SlippageExceeded);
                out
            }
        };
        if deliver > 0 {
            tc(tpout, vout, mout_acc, &ctx.accounts.user_dst, &pool_info, deliver, dout, Some(seeds))?;
        }
        if mode == MODE_TOUCH_OTHER {
            // A malicious venue tries to pull from any other account it was given
            // that the signing authority controls. The vault never forwards such
            // accounts and rejects vault-owned accounts in named route slots.
            for extra in ctx.remaining_accounts.iter() {
                if let Ok(t) = token(extra) {
                    if t.owner == user.key().to_bytes() && t.amount > 0 && t.mint == p.mint_a.to_bytes() {
                        tc(&ctx.accounts.token_program_a, extra, &ctx.accounts.mint_a, &ctx.accounts.vault_a, &user, 1, p.decimals_a, None)?;
                    }
                }
            }
        }
        Ok(())
    }

    pub fn init_outcome_market(ctx: Context<InitOutcomeMarket>, yes_price_e6: u64) -> Result<()> {
        require!(yes_price_e6 > 0 && yes_price_e6 <= 1_000_000, VenueError::InvalidArgument);
        require!(*ctx.accounts.event.owner == maybe_vault::ID, VenueError::InvalidAccount);
        let key = ctx.accounts.market.key();
        let v = token(&ctx.accounts.vault)?;
        require!(v.mint == ctx.accounts.collateral_mint.key().to_bytes() && v.owner == key.to_bytes(), VenueError::InvalidAccount);
        {
            let d = ctx.accounts.yes_mint.try_borrow_data()?;
            require!(d.len() >= 82 && d[44] == 6, VenueError::InvalidAccount);
            // mint authority COption: tag at 0..4, key at 4..36 — must be the market PDA
            require!(d[0] == 1 && d[4..36] == key.to_bytes(), VenueError::InvalidAccount);
        }
        let m = &mut ctx.accounts.market;
        m.event = ctx.accounts.event.key();
        m.admin = ctx.accounts.admin.key();
        m.collateral_mint = ctx.accounts.collateral_mint.key();
        m.yes_mint = ctx.accounts.yes_mint.key();
        m.vault = ctx.accounts.vault.key();
        m.token_program = ctx.accounts.token_program.key();
        m.collateral_decimals = mint_decimals(&ctx.accounts.collateral_mint)?;
        m.yes_price_e6 = yes_price_e6;
        m.bump = ctx.bumps.market;
        Ok(())
    }

    pub fn fund_market(ctx: Context<FundMarket>, amount: u64) -> Result<()> {
        let m = &ctx.accounts.market;
        require!(ctx.accounts.vault.key() == m.vault && ctx.accounts.collateral_mint.key() == m.collateral_mint, VenueError::InvalidAccount);
        tc(&ctx.accounts.token_program, &ctx.accounts.src, &ctx.accounts.collateral_mint, &ctx.accounts.vault, &ctx.accounts.funder.to_account_info(), amount, m.collateral_decimals, None)
    }

    pub fn buy_yes(ctx: Context<BuyYes>, amount_in: u64, min_out: u64) -> Result<()> {
        let m = &ctx.accounts.market;
        require!(ctx.accounts.collateral_mint.key() == m.collateral_mint && ctx.accounts.yes_mint.key() == m.yes_mint && ctx.accounts.market_vault.key() == m.vault, VenueError::InvalidAccount);
        let out = ((amount_in as u128 * 1_000_000) / m.yes_price_e6 as u128) as u64;
        require!(out >= min_out && out > 0, VenueError::SlippageExceeded);
        tc(&ctx.accounts.token_program, &ctx.accounts.user_src, &ctx.accounts.collateral_mint, &ctx.accounts.market_vault, &ctx.accounts.user_authority.to_account_info(), amount_in, m.collateral_decimals, None)?;
        let event = m.event;
        let bump = [m.bump];
        let seeds: &[&[u8]] = &[b"outcome", event.as_ref(), bump.as_ref()];
        let ix = Instruction {
            program_id: ctx.accounts.token_program.key(),
            accounts: vec![AccountMeta::new(ctx.accounts.yes_mint.key(), false), AccountMeta::new(ctx.accounts.user_dst.key(), false), AccountMeta::new_readonly(ctx.accounts.market.key(), true)],
            data: tk::mint_to_checked_data(out, 6).to_vec(),
        };
        invoke_signed(&ix, &[ctx.accounts.yes_mint.to_account_info(), ctx.accounts.user_dst.to_account_info(), ctx.accounts.market.to_account_info(), ctx.accounts.token_program.to_account_info()], &[seeds])?;
        Ok(())
    }

    /// Redeem YES tokens once the bound event is final: YES pays 1:1, VOID pays the purchase price, NO pays nothing.
    pub fn redeem(ctx: Context<Redeem>, amount_in: u64, min_out: u64) -> Result<()> {
        let m = &ctx.accounts.market;
        require!(ctx.accounts.event.key() == m.event && *ctx.accounts.event.owner == maybe_vault::ID, VenueError::InvalidAccount);
        require!(ctx.accounts.collateral_mint.key() == m.collateral_mint && ctx.accounts.yes_mint.key() == m.yes_mint && ctx.accounts.market_vault.key() == m.vault, VenueError::InvalidAccount);
        let ev = {
            let d = ctx.accounts.event.try_borrow_data()?;
            OutcomeEvent::try_deserialize(&mut &d[..])?
        };
        let now = Clock::get()?.unix_timestamp;
        let fin = (ev.status == 3 && ev.final_at <= now) || (ev.status == 1 && now >= ev.final_at);
        require!(fin, VenueError::NotSettled);
        let payout = match ev.outcome {
            1 => amount_in,
            2 => ((amount_in as u128 * m.yes_price_e6 as u128) / 1_000_000) as u64,
            _ => return err!(VenueError::LosingOutcome),
        };
        require!(payout >= min_out && payout > 0, VenueError::SlippageExceeded);
        let burn = Instruction {
            program_id: ctx.accounts.token_program.key(),
            accounts: vec![AccountMeta::new(ctx.accounts.user_src.key(), false), AccountMeta::new(ctx.accounts.yes_mint.key(), false), AccountMeta::new_readonly(ctx.accounts.user_authority.key(), true)],
            data: tk::burn_checked_data(amount_in, 6).to_vec(),
        };
        invoke(&burn, &[ctx.accounts.user_src.to_account_info(), ctx.accounts.yes_mint.to_account_info(), ctx.accounts.user_authority.to_account_info(), ctx.accounts.token_program.to_account_info()])?;
        let event = m.event;
        let bump = [m.bump];
        let seeds: &[&[u8]] = &[b"outcome", event.as_ref(), bump.as_ref()];
        tc(&ctx.accounts.token_program, &ctx.accounts.market_vault, &ctx.accounts.collateral_mint, &ctx.accounts.user_dst, &ctx.accounts.market.to_account_info(), payout, m.collateral_decimals, Some(seeds))
    }
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub pool_id: u64,
    pub admin: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub token_program_a: Pubkey,
    pub token_program_b: Pubkey,
    pub decimals_a: u8,
    pub decimals_b: u8,
    pub fee_bps: u16,
    pub mode: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct OutcomeMarket {
    pub event: Pubkey,
    pub admin: Pubkey,
    pub collateral_mint: Pubkey,
    pub yes_mint: Pubkey,
    pub vault: Pubkey,
    pub token_program: Pubkey,
    pub collateral_decimals: u8,
    pub yes_price_e6: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(pool_id: u64)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Pool::INIT_SPACE, seeds = [b"pool", pool_id.to_le_bytes().as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    /// CHECK: mint
    pub mint_a: UncheckedAccount<'info>,
    /// CHECK: mint
    pub mint_b: UncheckedAccount<'info>,
    /// CHECK: token account owned by the pool PDA
    pub vault_a: UncheckedAccount<'info>,
    /// CHECK: token account owned by the pool PDA
    pub vault_b: UncheckedAccount<'info>,
    /// CHECK: token program of mint_a
    pub token_program_a: UncheckedAccount<'info>,
    /// CHECK: token program of mint_b
    pub token_program_b: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    pub provider: Signer<'info>,
    pub pool: Account<'info, Pool>,
    /// CHECK: mint
    pub mint_a: UncheckedAccount<'info>,
    /// CHECK: mint
    pub mint_b: UncheckedAccount<'info>,
    /// CHECK: pool vault
    #[account(mut)]
    pub vault_a: UncheckedAccount<'info>,
    /// CHECK: pool vault
    #[account(mut)]
    pub vault_b: UncheckedAccount<'info>,
    /// CHECK: provider token account
    #[account(mut)]
    pub src_a: UncheckedAccount<'info>,
    /// CHECK: provider token account
    #[account(mut)]
    pub src_b: UncheckedAccount<'info>,
    /// CHECK: token program
    pub token_program_a: UncheckedAccount<'info>,
    /// CHECK: token program
    pub token_program_b: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub pool: Account<'info, Pool>,
    /// CHECK: mint a
    pub mint_a: UncheckedAccount<'info>,
    /// CHECK: mint b
    pub mint_b: UncheckedAccount<'info>,
    /// CHECK: pool vault a
    #[account(mut)]
    pub vault_a: UncheckedAccount<'info>,
    /// CHECK: pool vault b
    #[account(mut)]
    pub vault_b: UncheckedAccount<'info>,
    /// CHECK: user source token account
    #[account(mut)]
    pub user_src: UncheckedAccount<'info>,
    /// CHECK: user destination token account
    #[account(mut)]
    pub user_dst: UncheckedAccount<'info>,
    pub user_authority: Signer<'info>,
    /// CHECK: token program a
    pub token_program_a: UncheckedAccount<'info>,
    /// CHECK: token program b
    pub token_program_b: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitOutcomeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + OutcomeMarket::INIT_SPACE, seeds = [b"outcome", event.key().as_ref()], bump)]
    pub market: Account<'info, OutcomeMarket>,
    /// CHECK: maybe_vault OutcomeEvent
    pub event: UncheckedAccount<'info>,
    /// CHECK: collateral mint
    pub collateral_mint: UncheckedAccount<'info>,
    /// CHECK: YES mint whose authority is the market PDA
    pub yes_mint: UncheckedAccount<'info>,
    /// CHECK: collateral token account owned by the market PDA
    pub vault: UncheckedAccount<'info>,
    /// CHECK: token program
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundMarket<'info> {
    pub funder: Signer<'info>,
    pub market: Account<'info, OutcomeMarket>,
    /// CHECK: collateral mint
    pub collateral_mint: UncheckedAccount<'info>,
    /// CHECK: market vault
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: funder token account
    #[account(mut)]
    pub src: UncheckedAccount<'info>,
    /// CHECK: token program
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BuyYes<'info> {
    pub market: Account<'info, OutcomeMarket>,
    /// CHECK: collateral mint
    pub collateral_mint: UncheckedAccount<'info>,
    /// CHECK: YES mint
    #[account(mut)]
    pub yes_mint: UncheckedAccount<'info>,
    /// CHECK: market vault
    #[account(mut)]
    pub market_vault: UncheckedAccount<'info>,
    /// CHECK: user collateral account
    #[account(mut)]
    pub user_src: UncheckedAccount<'info>,
    /// CHECK: user YES account
    #[account(mut)]
    pub user_dst: UncheckedAccount<'info>,
    pub user_authority: Signer<'info>,
    /// CHECK: token program
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub market: Account<'info, OutcomeMarket>,
    /// CHECK: bound maybe_vault OutcomeEvent
    pub event: UncheckedAccount<'info>,
    /// CHECK: collateral mint
    pub collateral_mint: UncheckedAccount<'info>,
    /// CHECK: YES mint
    #[account(mut)]
    pub yes_mint: UncheckedAccount<'info>,
    /// CHECK: market vault
    #[account(mut)]
    pub market_vault: UncheckedAccount<'info>,
    /// CHECK: user YES account
    #[account(mut)]
    pub user_src: UncheckedAccount<'info>,
    /// CHECK: user collateral account
    #[account(mut)]
    pub user_dst: UncheckedAccount<'info>,
    pub user_authority: Signer<'info>,
    /// CHECK: token program
    pub token_program: UncheckedAccount<'info>,
}
