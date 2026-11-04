# MAYBE interface contract

Status: v1 (2026-11-04). This document is normative for the vault program, the TypeScript engine (`packages/core`), the SDK (`packages/sdk`), the API, and agents. Where this document and code disagree, the conformance fixtures in `packages/core/conformance/` decide, and the disagreement is a bug.

## 1. Trust boundaries in one paragraph

The browser, the API server, workers, keepers and agents are **untrusted instruction submitters**. A user's authority over funds is exercised only by their wallet signing (a) deposits/withdrawals and (b) a specific **plan** — a bounded binary program (`MYB1`) that the vault program parses, validates and stores, and then enforces on every execution. Keepers are permissionless cranks: they can cause an action to execute only when the program itself concludes the plan allows it at that moment. The admin can list assets/routes/attestor sets and pause *new* executions; the admin can never move vault funds, alter a plan, or block withdrawals, cancellations or refunds.

## 2. Programs and keys (localnet)

| Program | Localnet ID | Purpose |
|---|---|---|
| `maybe_vault` | `pUZiiWnMzroxAxPDJsjH337T5Fm9WNy92EiLNFGHgyy` | vaults, plans, reservations, execution, outcome registry, agent policies |
| `maybe_testvenue` | `4Na5xvms9PXcE7KYq97juhzznM9jsKQ5dgSJxfR4pHDJ` | **local only**: constant-product pools, a binary outcome market, and switchable misbehaviour for route-safety tests |

Keypairs in `programs/keys/localnet/` are throwaway localnet fixtures. They must never be used on devnet or mainnet; deployment scripts refuse to run with them on any non-local cluster. Dev attestors (`dev_attestor_*`) exist only for the local settlement adapter and are refused when `Config.allow_dev_attestors == false`.

## 3. Accounts (PDAs of `maybe_vault`)

All accounts are Anchor accounts (8-byte discriminator). Seeds are byte strings; integers little-endian.

| Account | Seeds | Key fields |
|---|---|---|
| `Config` | `["config"]` | admin, treasury_owner, max_fee_bps_cap (≤ 100), allow_dev_attestors, paused_execution, assets[16] {mint, token_program, decimals, enabled}, routes[4] {kind, program_id, enabled}, bump |
| `AttestorSet` | `["attestors", set_id u64]` | keys[≤5], revoked bitmap u8, threshold u8, adjudication_threshold u8, is_dev bool, challenge_seconds u32, dispute_timeout_seconds u32, bump |
| `Event` | `["event", adapter u8, market_id_hash [32], rule_hash [32], binding [32]]` where binding = attestor-set address (attestation) or watched token account (balance) | adapter, venue u8, market_id_hash, rule_hash, binding, status u8, outcome u8, proposed_at i64, final_at i64, last_nonce u64, threshold u64, deadline i64, watched_mint, bump |
| `Vault` | `["vault", owner, vault_id u64]` | owner, vault_id, policy_epoch u32, strategy_count u64, balances[8] {mint, available u64, reserved u64}, bump |
| vault token account | ATA(vault PDA, mint, token_program) | authority = vault PDA |
| `Strategy` | `["strategy", vault, strategy_id u64]` | vault, owner, creator (owner or policy), strategy_id, version u32, plan_hash [32], plan_len u16, written u16, status u8, activated_at, closed_at, holdings[4][6] u64, group_claims[8] u8, actions[12] {runs_done u16, executed_runs u16, first_executed_at i64, last_executed_at i64, received u64, spent u64, fees u64}, exec_nonce u64, plan bytes (≤ 2600) |
| `Policy` | `["policy", vault, session_key]` | vault, owner, session_key, epoch u32, flags (can_create, can_cancel), allowed_mints[6], allowed_routes[6], allowed_recipients[4], max_total[6], max_per_action[6], spent[6], max_fee_bps u16, expires_at i64, revoked bool, bump |

Statuses: Strategy `0 UPLOADING, 1 ACTIVE, 2 PAUSED, 3 COMPLETED, 4 EXPIRED, 5 CANCELLED`. Event `0 OPEN, 1 PENDING, 2 DISPUTED, 3 FINAL`; outcome `0 NO, 1 YES, 2 VOID`.

## 4. Plan format `MYB1`

Little-endian, strict, canonical (exactly one encoding per plan). Reference implementation: `packages/core/src/plan.ts` (`encodePlan`, `decodePlan`, `checkPlanStructure`).

Header (32 bytes): `magic "MYB1"`, `version u8 = 1`, `flags u8` (bit0 = cancel locked until expiry), `n_events, n_mints, n_refs, n_allocs, n_nodes, n_actions` (u8 each), `max_fee_bps u16`, `void_policy u8 = 0`, `reserved u8 = 0`, `expires_at i64`, `nonce u64`.

Then `events[n]×32`, `mints[n]×32`, `refs[n]×32`, `allocs[n]×16 {mint_idx u8, 7×0, amount u64}`, `nodes[n]×24 {op, a, b, k, n_children, 3×0, children[8] (unused = 0xFF), param i64}`, `actions[n]×72`:

| off | type | field |
|---|---|---|
| 0 | u8 | kind: 1 SWAP, 2 TRANSFER, 3 RELEASE |
| 1 | u8 | guard node |
| 2 | u8 | allocation |
| 3 | u8 | in_mint |
| 4 | u8 | out_mint (0xFF unless SWAP) |
| 5 | u8 | route_kind: 0 none, 1 CP_SWAP, 2 OUTCOME_BUY, 3 OUTCOME_REDEEM |
| 6 | u8 | ref: pool (SWAP), recipient wallet (TRANSFER), 0xFF (RELEASE) |
| 7 | u8 | branch group (0xFF none) |
| 8 | u8 | branch |
| 9 | u8 | amount_kind: 1 FIXED, 2 BPS_OF_ALLOCATION, 3 BPS_OF_RECEIVED, 4 ALL_OF_HOLDING |
| 10 | u8 | amount_ref (source action for BPS_OF_RECEIVED, else 0xFF) |
| 11 | u8 | flags: bit0 min_out is a rate ×1e9, bit1 missed runs catch up |
| 12 | u16 | bps |
| 14 | u16 | fee_bps (≤ plan max_fee_bps) |
| 16 | u16 | runs (1..52) |
| 18 | 2×0 | reserved |
| 20 | u32 | delay seconds |
| 24 | u32 | interval seconds (0 iff runs = 1) |
| 28 | 4×0 | reserved |
| 32 | u64 | amount: FIXED per run; cap for BPS_OF_RECEIVED / ALL_OF_HOLDING (0 = none) |
| 40 | u64 | min_out per run, or rate ×1e9 |
| 48 | i64 | deadline (0 = strategy expiry) |
| 56 | 16×0 | reserved |

Limits: events ≤ 8, mints 1..6, refs ≤ 6, allocations 1..4, nodes 1..24, actions 1..12, children ≤ 8, depth ≤ 8, plan ≤ 2600 bytes, fee ≤ 100 bps, duration ≤ 400 days. Node ops: `0 ALWAYS, 1 OUTCOME(a=event,b=outcome), 2 NOT, 3 AND, 4 OR, 5 ATLEAST(k), 6 VETO(a=event,b=outcome,children[0]=trigger,param=window), 7 RECEIPT(a=ref|0xFF self, b=action), 8 AFTER(param=unix)`. Children must have a smaller index than their parent (topological order ⇒ acyclic).

All structural rules are listed in `checkPlanStructure`. The program implements the same list; `conformance/invalid_plans.json` gives mutated plans with the expected error code.

## 5. Semantics (normative summary)

* **Predicates** — time-of-truth evaluation, `predicate.ts` header comment. Values: TRUE / FALSE / PENDING. Only *final* outcomes count. `PENDING` attestations are final at `final_at = proposed_at + challenge`; `DISPUTED` is never final; balance events are final NO at `deadline + 1`. VOID makes every OUTCOME leaf on that event FALSE (frozen per plan, `void_policy = 0`). NOT of an unresolved event is unresolved. VETO evaluates at `T = trigger.t + window` using recorded timestamps, so results never depend on keeper timing; a veto final exactly at `T` counts.
* **Readiness** of action *i* (`engine.ts › actionReadiness`), in order: strategy paused → blocked; closed → done; `runs_done ≥ runs` → done; `now ≥ deadline` → done; branch claimed by another branch → done; guard FALSE → done; guard PENDING → waiting; compute `run` (skip policy auto-advances past runs whose window has passed); `run_at = guard.t + delay + run × interval`; `run_at ≥ deadline` → done; `now < run_at` → scheduled; execution paused → blocked; amount = 0 or > holding → blocked; otherwise executable with `amount`, `fee = ⌊amount × fee_bps / 10⁴⌋`, `amount_in = amount − fee`, `min_out` (rate: `max(1, ⌊amount_in × rate / 10⁹⌋)`).
* **Execution** (`executeAction`): caller supplies `expected_plan_hash` and `run` (per-action nonce). SWAP: CPI to the configured route program for `route_kind`, through exactly the plan's pool, from the vault's `in_mint` token account to its `out_mint` token account; measure both balances before/after. Require `0 < spent_in ≤ amount_in` and `received_out ≥ min_out` (rate recomputed on `spent_in`). Fee is pro-rata: `fee = ⌊fee_full × spent_in / amount_in⌋`, transferred to the treasury ATA after the swap. `holdings[alloc][in] −= spent_in + fee`, `holdings[alloc][out] += received_out`, vault `reserved` adjusted identically. TRANSFER: `amount_in` to `ATA(recipient, mint)`, fee to treasury. RELEASE: holdings → vault `available`. Then claim the branch group, `runs_done = run + 1`, `executed_runs += 1`, set first/last executed, `received += out`, `spent += taken`, `fees += fee`, `exec_nonce += 1`, emit `ExecutionReceipt`. Any failure reverts the whole transaction: nothing is consumed.
* **Close**: CANCEL (owner, unless cancel-locked and `now < expires_at`), EXPIRE (anyone, `now ≥ expires_at`), COMPLETE (anyone, all actions done). All holdings return to `available`. Withdrawals touch only `available` and are never paused.
* **Activation**: strict decode, `sha256(plan) == plan_hash` committed at creation, `now < expires_at ≤ now + 400d`, every non-zero action deadline `> now`, `max_fee_bps ≤ config cap`, every mint enabled in `Config.assets` with matching token program, every OUTCOME/VETO event account owned by the program with the plan's address, every SWAP ref pool owned by the configured route program, reservation per mint ≤ available. Moves available → reserved.

## 6. Instructions (`maybe_vault`)

| Instruction | Signer | Notes |
|---|---|---|
| `init_config(max_fee_bps_cap, allow_dev_attestors)` | admin | once |
| `set_asset(mint, enabled)` | admin | validates token program; Token-2022 mints may only carry `MetadataPointer, TokenMetadata, GroupPointer, GroupMemberPointer, TokenGroup, TokenGroupMember` |
| `set_route(kind, program_id, enabled)` | admin | |
| `set_paused(paused_execution)` | admin | blocks `execute_action` only |
| `init_attestor_set(set_id, keys, threshold, adjudication_threshold, challenge_seconds, dispute_timeout_seconds, is_dev)` | admin | `is_dev` rejected unless `allow_dev_attestors` |
| `revoke_attestor(set_id, index)` | admin | |
| `create_event(adapter, venue, market_id_hash, rule_hash, threshold, deadline)` | anyone (payer) | binding account passed; identity fully in seeds |
| `attest(outcome, observed_at, nonce, expires_at)` | anyone + Ed25519 precompile ix(s) | ≥ threshold distinct non-revoked keys signed the message below; `nonce > last_nonce`; `now ≤ expires_at`. OPEN→PENDING; same outcome while PENDING → no-op; different outcome while PENDING → DISPUTED; FINAL ignores |
| `adjudicate(outcome, nonce, expires_at)` | anyone + Ed25519 | ≥ adjudication_threshold signatures; DISPUTED → FINAL(outcome) |
| `void_disputed()` | anyone | DISPUTED and `now ≥ proposed_at + dispute_timeout` → FINAL(VOID) |
| `observe_balance()` | anyone | balance adapter; `now ≤ deadline` and watched amount ≥ threshold → FINAL YES at now |
| `init_vault(vault_id)` | owner | |
| `deposit(amount)` / `withdraw(amount)` | owner | `transfer_checked`; withdraw ≤ available; never paused |
| `create_strategy(strategy_id, version, plan_len, plan_hash)` | owner or policy session key | allocates the plan buffer |
| `write_plan(offset, bytes)` | creator | contiguous writes |
| `activate_strategy()` | creator | §5 Activation; with a policy signer, also every check in `policy.ts › checkPolicyForPlan`, then charge `spent` |
| `execute_action(action, run, expected_plan_hash)` | anyone (keeper) | remaining accounts: all plan events in order, then receipt-referenced strategies in ref order, then action accounts |
| `pause_strategy(paused)` / `cancel_strategy()` | owner | |
| `close_expired()` / `close_completed()` | anyone | |
| `create_policy(...)` / `revoke_policy()` / `kill_switch()` | owner | kill switch bumps `vault.policy_epoch` |

Attestation message (domain separated, signed by each attestor with Ed25519):
`"MAYBE_ATTEST_V1" ‖ program_id ‖ event ‖ rule_hash ‖ outcome u8 ‖ observed_at i64 ‖ nonce u64 ‖ expires_at i64`. Adjudication uses the domain `"MAYBE_ADJUDICATE_V1"`.

Route CPI for `CP_SWAP` (`maybe_testvenue::swap(amount_in, min_out)`), accounts: `pool (w), pool_vault_a (w), pool_vault_b (w), user_src (w), user_dst (w), user_authority (signer = vault PDA), token_program`. The vault builds the instruction data itself. Before the CPI it checks that no account in the route slice other than `user_src`/`user_dst` is a token account whose authority is the vault PDA. `OUTCOME_BUY`/`OUTCOME_REDEEM` follow the same pattern against the outcome market.

## 7. Events (logs)

`ExecutionReceipt { strategy, plan_hash, action u8, run u16, skipped_runs u16, exec_nonce u64, at i64, kind u8, in_mint, out_mint, amount u64, fee u64, amount_in u64, amount_out u64, recipient }`, `StrategyActivated`, `StrategyClosed { mode, refunded[] }`, `Deposited`, `Withdrawn`, `EventResolved { status, outcome, final_at }`, `PolicyChanged`.

## 8. Error codes

Engine-level names match `EngineErrorCode` in `engine.ts` (`GUARD_PENDING`, `GUARD_FALSE`, `DELAY_PENDING`, `RUN_NOT_DUE`, `RUN_OUT_OF_ORDER`, `ACTION_COMPLETE`, `DEADLINE_PASSED`, `BRANCH_LOST`, `AMOUNT_ZERO`, `INSUFFICIENT_ALLOCATION`, `ROUTE_FAILED`, `ROUTE_DELTA_VIOLATION`, `MIN_OUT_NOT_MET`, `PLAN_HASH_MISMATCH`, `EXECUTION_PAUSED`, `STRATEGY_PAUSED`, `STRATEGY_CLOSED`, `NOT_OWNER`, `CANCEL_LOCKED`, `NOT_EXPIRED`, `NOT_COMPLETE`, …). Plan errors match `PlanErrorCode`. Program-only codes: `UNSUPPORTED_TOKEN_EXTENSION`, `ASSET_NOT_ENABLED`, `ROUTE_NOT_ENABLED`, `ROUTE_ACCOUNT_MISMATCH`, `FOREIGN_VAULT_ACCOUNT_IN_ROUTE`, `ATTESTATION_INVALID`, `ATTESTATION_REPLAY`, `ATTESTATION_EXPIRED`, `DEV_ATTESTOR_FORBIDDEN`, `POLICY_VIOLATION`, `POLICY_REVOKED`, `PLAN_HASH_INVALID`, `PLAN_INCOMPLETE`.

## 9. API contract (summary)

JSON over HTTPS; u64 amounts are decimal strings; timestamps are unix seconds. Every mutating request carries `Idempotency-Key`. Auth: Sign-In-With-Solana style challenge (`domain`, `address`, `statement`, `uri`, `chain`, `nonce`, `issued_at`, `expiration_time`) → session cookie. The server returns **unsigned transactions** for wallet-signed operations and never sees owner keys. Endpoints are listed in `apps/server/src/routes/*` and mirrored by the web app's `Backend` interface (`apps/web/src/data/backend.ts`), which the simulation backend implements in-browser.
