# Feature matrix

Status as of 2026-11-04. **Implemented & tested** means exercised by an automated test listed in the last column. **Local only** means it works against the local validator with development keys or test venues and needs production counterparts. **Externally blocked** names the exact missing requirement. **Deferred** is a deliberate scope cut.

Test suites: `core` (110), `agent` (11), `sdk` (17: 5 unit + 12 on a live validator), Rust `maybe-logic` (11) + `maybe-vault` layout (1), `server` (13, Postgres), `web` (4), browser (Playwright, `apps/web/e2e`), end to end (`pnpm e2e:chain`, `docs/evidence/e2e-chain.md`).

## Strategy language and engine

| Feature | Status | Evidence |
|---|---|---|
| Canonical plan format (MYB1), strict decoding, hash | Implemented & tested | core; Rust conformance (16 plans, 20 malformed) |
| AND / OR / NOT / at-least-k / veto window / after / always / receipt nodes | Implemented & tested | core; conformance (400 predicate cases) |
| Unresolved, pending, disputed, voided outcomes; deadline boundaries | Implemented & tested | core property tests; conformance |
| Delays, schedules (skip / catch-up), action deadlines | Implemented & tested (host) | core; conformance (1,296 cases). Not run live on the validator: needs clock warps |
| Branch groups (mutually exclusive) | Implemented & tested | core; SDK flagship; e2e flagship |
| Amounts: fixed, % of allocation, % of received, all of holding | Implemented & tested | core; SDK proceeds template |
| Fees: bounded, pro-rata on partial fills, treasury only, none on release | Implemented & tested | core; conformance; SDK receipts |
| Simulator: every outcome combination, worst-case gross/net spend, fees, recipients | Implemented & tested | core |
| Validator with located issues; funding checks | Implemented & tested | core; web builder |
| 16 templates incl. the flagship 500 USDC plan | Implemented & tested | core (every template compiles, simulates and round-trips) |
| Formal state machines (strategy, action, tx, event, job, policy) | Implemented & tested | core |
| Probability / price-threshold triggers | Deferred (feature-gated off) | `docs/DECISIONS.md` D10 |

## Solana programs

| Feature | Status | Evidence |
|---|---|---|
| PDA vaults, per-mint available/reserved ledger, canonical token accounts | Implemented & tested | SDK; e2e reconciliation |
| Chunked plan upload, hash verification, activation with reservation | Implemented & tested | SDK; e2e |
| Execution with run nonce, branch claims, route delta checks, min received | Implemented & tested | SDK (malicious routes); e2e crash tests |
| Close: complete / expire / cancel with refunds | Implemented & tested | SDK; e2e (complete, VOID refund, cancel) |
| Attestor sets: k-of-n Ed25519, domain separation, nonce, expiry, challenge, dispute, adjudication, void on timeout | Implemented & tested | SDK (7 attack cases + dispute flow) |
| Objective balance-threshold event adapter | Implemented & tested | SDK |
| Capability policies (mints, routes, recipients, caps, fee cap, expiry, epoch) + kill switch | Implemented & tested | SDK; e2e (server pre-check and direct on-chain refusals) |
| Emergency pause (blocks new steps only) | Implemented & tested | SDK; core |
| Token-2022 allowlist (metadata-only Pump-style mints accepted; fee/hook/delegate mints refused) | Implemented & tested | SDK |
| Local test venue: CP pools, outcome market, malicious pools | Local only | SDK |
| Jupiter (`/build` Router) route adapter | Externally blocked: needs mainnet RPC access and Jupiter's API (both unreachable from this environment) | `docs/ONCHAIN_INVARIANTS.md` |
| PumpSwap / Pump bonding-curve adapter | Externally blocked: needs the mainnet programs (can't be cloned without mainnet RPC) | same |
| Rent reclaim for closed strategies | Deferred | — |
| Upgrade authority / multisig governance | Deferred (deployment concern) | `docs/DEPLOYMENT.md` |

## Backend and workers

| Feature | Status | Evidence |
|---|---|---|
| Sign-in with Solana: domain-bound, single-use, expiring challenges; hashed session tokens | Implemented & tested | server tests |
| Rate limiting (Postgres token bucket) | Implemented & tested | server tests |
| Unsigned transaction building; wallet signs exact bytes; signature verification before send | Implemented & tested | e2e (every money action) |
| Ordered, resumable, idempotent transaction pipeline with leases | Implemented & tested | server tests; e2e resumable authorization |
| Durable jobs: idempotent keys, SKIP LOCKED, leases, backoff, dead letters | Implemented & tested | server tests; e2e crash tests |
| Indexer → projections, receipts (unique per run), activity | Implemented & tested | e2e |
| Keeper (permissionless crank), settlement watcher, finality cranks | Implemented & tested | e2e |
| Reconciliation of ledger vs actual token balances | Implemented & tested | e2e |
| Transactional outbox + LISTEN/NOTIFY → SSE | Implemented & tested | server tests (commit-only delivery) |
| Health, structured redacted logs, ops screen | Implemented | `/v1/health`, `/v1/ops`, web Operations |
| Configuration safety (no dev attestors / local fixtures / mock settlement in production) | Implemented & tested | server tests |
| Prometheus-style metrics endpoint | Deferred | ops endpoint exposes the same counters as JSON |
| Server-held agent session keys | Local only (`.localnet/session-keys`); production needs a KMS/HSM | — |

## Web app

| Feature | Status | Evidence |
|---|---|---|
| Shell: sidebar, mobile bottom nav, command palette (⌘K, /), g-shortcuts, persistent environment label | Implemented & tested | browser keyboard tests |
| Overview without double counting | Implemented | web |
| Discover: filters, sample quotes with timestamps, rules, market drawer, non-binary markets shown but not tradable | Implemented & tested | browser a11y + flow |
| Future Builder: sentence + graph + list over one document, undo/redo, located validation | Implemented & tested | browser flow; a11y |
| Review: plain-language authorization, paths, worst case, fees, cancellation and failure rules | Implemented & tested | browser flow; web unit |
| Money: deposit / withdraw / assign with previews; drag shortcut with form equivalent | Implemented & tested | browser safety tests |
| Agents: four roles, sessions, sources/tool calls/receipts trail, permissions, kill switch | Implemented & tested | agent tests; e2e |
| Future Rooms: immutable versions, clone into own vault, honest records | Implemented & tested | server tests (append-only versions); web |
| Simulation backend (everything in the browser) | Implemented & tested | web unit; browser |
| Localnet backend (API + local dev wallet + local controls) | Implemented; exercised through the same API by `pnpm e2e:chain` | e2e |
| Wallet Standard (Phantom, Backpack…) | Deferred: the local dev wallet covers localnet; devnet needs a real wallet adapter | — |

## External venues

| Venue | Status | Exact requirement |
|---|---|---|
| Polymarket (read-only discovery and quotes) | Externally blocked | outbound access to `gamma-api.polymarket.com` / `clob.polymarket.com` from the server (refused by this environment's network allowlist). Trading by a vault is not possible (Polygon, off-chain signed orders) |
| Kalshi (read-only) | Externally blocked | outbound access to Kalshi's public API; trading needs Kalshi accounts and identity verification |
| DFlow (tokenized Kalshi) | Externally blocked / not vault-compatible | API key for production hosts, Proof KYC on the receiving wallet, geoblocking; `/order` returns user-signed transactions |
| Resolution of real venues via attestation | Deferred | a production attestor set (operators, keys, threshold, revocation policy) |

## Token

| Feature | Status | Note |
|---|---|---|
| MAYBE token (fictional, local Token-2022 mint with metadata) | Local only | no Pump token was created; no mainnet deployment |
| Fee discounts / bonded publishing | Deferred | not implemented, so not claimed |
