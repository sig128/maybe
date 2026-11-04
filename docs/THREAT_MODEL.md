# Threat model

Assets at stake: tokens in user vaults; the user's authority over them (wallet key, agent policies); the integrity of outcomes that trigger spending; the honesty of what the interface shows. Each threat lists the mitigation and where it's proven. "Program" means `maybe_vault`; invariant numbers refer to `docs/ONCHAIN_INVARIANTS.md`.

## Actors

| Actor | Can | Can't (by design) |
|---|---|---|
| Vault owner (wallet) | deposit, withdraw available, authorize/pause/cancel plans, grant/revoke policies, kill switch | spend reserved funds outside a plan |
| Keeper / anyone | call `execute_action`, closes, observe/finalize cranks | choose amounts, routes, recipients or timing beyond the plan |
| Agent session key | create plans inside its policy | withdraw, exceed caps, raise its own limits, act after revocation |
| Attestor set | sign outcomes for events bound to it | move funds, alter plans |
| Program admin | list assets/routes, set the emergency pause, create attestor sets | move vault funds (invariant 20) |
| Server operator | build transactions, run workers, read projections | sign for users, alter signed plans |

## Threats

| # | Threat | Mitigation | Evidence |
|---|---|---|---|
| T1 | Server or UI swaps the plan after review | Wallet signs exact message bytes; server verifies signatures against those bytes (`Chain.attach`); program checks `sha256(plan) == committed hash` at activation and every execution | inv. 1; e2e "stale review hash is refused"; SDK account-substitution test |
| T2 | A compromised keeper spends at the wrong time, amount or place | Program recomputes readiness, amounts, fees and minimum received; route program, pool and mint pair pinned by the plan | inv. 4, 10–12; conformance (1,296 cases) |
| T3 | Malicious route drains other vault balances or underdelivers | No vault-owned account allowed in the route slice; balance deltas checked (`0 < spent ≤ amount`, received ≥ minimum) | inv. 10; SDK overspend / underdeliver / redirect / vault-account-in-route tests |
| T4 | Duplicate execution (retries, two workers, crash after send) | Per-action run nonce on-chain; job keys `(strategy, action, run)`; handler re-reads chain | inv. 8; e2e crash-after-send and crash-before-send |
| T5 | Double reservation / spending reserved funds | Ledger moves available → reserved at activation; withdraw only from available | inv. 5–6; e2e race (activation after a withdrawal fails with nothing reserved); core property tests |
| T6 | Both branches of an either/or execute | Group claim by first executed branch | inv. 7; e2e flagship (release branch blocked after YES) |
| T7 | Forged or replayed outcome | k-of-n distinct non-revoked keys; domain `MAYBE_ATTEST_V1`; event, rule hash, outcome, nonce (strictly increasing), expiry; Ed25519 precompile offset checks | inv. 13; SDK attestation attack tests (7 cases) |
| T8 | Correlated or dishonest attestors | Not solved by a threshold: labelled "trusted attestation" in the UI and review; challenge window, dispute → adjudication or VOID; attestor revocation | UI labels; inv. 13 |
| T9 | Development signers reach production | Program `allow_dev_attestors` flag, one-way disable; server refuses dev attestors in production config | inv. 14; `apps/server/test/server.test.ts` (configuration safety) |
| T10 | Mainnet funds routed to mock settlement | Server refuses local fixtures with a mainnet RPC; localnet keys load only in localnet mode; setup refuses a non-local RPC | server config tests; `localnet-setup.ts` guard |
| T11 | Prompt injection makes an agent move money | No money-moving tools exist for any role; external text fenced as data and flagged; deterministic assistant; drafts are unfunded | agent tests; e2e "instructions injected into chat move nothing" |
| T12 | Agent exceeds its authority | Policy account: mints, routes, recipients, per-step and total caps, fee cap, expiry, epoch; kill switch bumps the epoch | inv. 18; e2e: server pre-check and *direct* on-chain refusals (cap, route), withdraw refused, kill switch |
| T13 | Session hijack / replayed sign-in | Single-use, domain-bound, expiring challenges; signature over the full message; tokens stored as hashes | server tests (replay, wrong signer, wrong domain, tampered message) |
| T14 | Token-extension tricks (transfer fees, hooks, delegates) | Mint allowlist: classic SPL or Token-2022 with metadata/group extensions only | inv. 16; SDK test (fee mint refused, metadata-only mint listed) |
| T15 | Admin abuse | Admin can't move vault funds; delisting can't block withdrawals; route changes fail closed | inv. 20 (design review) |
| T16 | Emergency pause traps funds | Pause blocks `execute_action` only | inv. 19; SDK pause test |
| T17 | Misleading display (double counting, fake activity) | Overview counts each unit once (available + reserved, holdings inside reserved); sample data labelled; rooms distinguish live/paper/backtest | web review; `docs/DECISIONS.md` D12 |
| T18 | Accidental fund movement from UI gestures | Drag-to-allocate opens a confirmation form; no keyboard shortcut signs anything | browser QA (see `docs/QA.md`) |
| T19 | Stale projections lead to wrong decisions | Spending decisions re-read the chain; projections are display only; reconciliation compares ledger to token balances every 15 s | e2e reconciliation steps |
| T20 | RPC outage, blockhash expiry, ambiguous submission | Transactions recorded with their blockhash window; resend identical bytes (same signature) or mark EXPIRED; leases resume abandoned intents | `flows.ts` `runIntent`; e2e resumable authorization |

## Out of scope / residual risk

- **Program upgrade authority and `init_config` front-running** are deployment concerns: deploy and initialize in one operator step; put upgrade authority behind a multisig (not configured here).
- **External venue risk** (Polymarket, Kalshi/DFlow) isn't present: those venues aren't traded by vaults in this build.
- **Session keys on localnet** sit on disk in `.localnet/session-keys`; production requires a KMS/HSM.
- **Rent of closed strategy accounts** isn't reclaimed (cost, not safety).
- No third-party audit has been performed.
