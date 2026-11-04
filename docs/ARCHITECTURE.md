# Architecture

MAYBE turns "if this happens, do that with my money" into a plan a Solana program enforces. This page is the map: what runs where, who is trusted with what, and where each guarantee comes from.

## Pieces

```
                    ┌──────────────────────── browser ────────────────────────┐
                    │  apps/web  (Vite + React)                               │
                    │   Discover · Futures (sentence / graph / list) · Review │
                    │   Money · Agents · Rooms · Activity · Ops               │
                    │                                                         │
                    │   Backend interface (@maybe/api)                        │
                    │    ├─ SimulationBackend: engine + ledger in the browser │
                    │    └─ HttpBackend: API + wallet signs exact bytes       │
                    └───────────────┬─────────────────────────────────────────┘
                                    │ HTTPS JSON (tagged bigints) · SSE
                    ┌───────────────▼────────────── apps/server ─────────────┐
                    │ API (Hono)          │ Worker                           │
                    │  SIWS auth, rate    │  indexer → projections, receipts │
                    │  limits, drafts,    │  keeper (permissionless crank)   │
                    │  prepare/review,    │  settlement watcher (observe,    │
                    │  build unsigned tx, │   finalize, void disputed)       │
                    │  submit + track,    │  tx recovery, reconciliation     │
                    │  agents, rooms, ops │                                  │
                    └──────────┬──────────┴───────────────┬──────────────────┘
                               │ PostgreSQL: intents, transactions, jobs,     │
                               │ outbox (LISTEN/NOTIFY), projections, rooms   │
                               │                                              │
                    ┌──────────▼──────────────────────────▼──────────────────┐
                    │ Solana                                                  │
                    │  maybe_vault: config · attestor sets · outcome events · │
                    │   vaults · strategies (plan bytes) · policies           │
                    │  route programs (localnet: maybe_testvenue)             │
                    └─────────────────────────────────────────────────────────┘
```

Shared code, all TypeScript source (no build step):

| Package | Role |
|---|---|
| `packages/core` | Plan format, predicate semantics, engine, ledger, simulator, validator, compiler, templates, state machines. The reference semantics. |
| `packages/api` | The web ↔ backend contract: types, wire serialization, and the pure view builders both backends use. |
| `packages/agent` | Agent roles, tool allowlists, injection boundary, deterministic local assistant, model provider adapter. |
| `packages/sdk` | PDAs, instruction builders, account decoders, attestation helpers, engine bridge for the programs. |
| `programs/crates/maybe-logic` | Rust port of the core semantics, used by the program. |

## Who enforces what

| Guarantee | Enforced by | Not enforced by |
|---|---|---|
| Only the signed plan runs; it can't change after activation | program (hash check at activation and execution) | the server, the UI |
| Steps spend only within their allocation, mints, routes, recipients, minimum received and fee bounds | program | the keeper |
| Reserved funds can't be spent twice or withdrawn | program ledger | database projections |
| A run executes at most once | program run counter | the job queue |
| Branch exclusivity | program group claims | — |
| Outcome evidence | program (k-of-n signatures, domain, nonce, expiry, challenge window) or direct balance observation | the attestor's honesty (trusted attestation is labelled as such) |
| Agent limits | program (policy account; session key can never withdraw) | the agent runtime, the server pre-check |
| What the user saw is what they signed | wallet signs exact message bytes; server verifies before sending | — |

The server and browser are **untrusted instruction submitters**. The keeper is a permissionless crank: anyone can call `execute_action`, and the program decides.

## Flows

**Authorize.** Review (validate → compile → simulate → describe, all in `@maybe/api` `prepareStrategy`) → the user approves a plan hash → the server rebuilds and refuses if the hash changed → it returns unsigned transactions: open vault token accounts if needed, `create_strategy` (commits hash), `write_plan` chunks, `activate_strategy` (verifies bytes, validates the plan and its accounts, reserves). The wallet signs; the server attaches signatures, verifies them against the exact bytes, then sends in order. An interrupted upload resumes from what was written.

**Execute.** The worker's keeper evaluates readiness from projections and enqueues one job per `(strategy, action, run)`. The handler re-reads the chain, recomputes readiness, and sends `execute_action`. Receipts come from the transaction's program events and are inserted once (primary key). A crash anywhere is recovered by lease expiry plus a fresh chain read.

**Settle.** Attestation outcomes arrive as signed attestations; balance events are cranked by the settlement watcher when the watched balance crosses the threshold. Finality is lazy, so no crank is needed for correctness.

**Close.** When every step is terminal the keeper calls `close_completed`; at expiry `close_expired`; the owner can `cancel_strategy` (unless locked). All return holdings to available.

## Environments

| | Simulation | Local validator | Devnet | Production |
|---|---|---|---|---|
| Ledger | browser (`@maybe/core`) | `maybe_vault` on `solana-test-validator` | `maybe_vault` (deploy prepared, not run) | not configured |
| Wallet | simulated | local dev keypair (labelled) | Wallet Standard (not wired) | — |
| Outcomes | simulation controls | dev attestors 2-of-3, objective balance events | — | production attestors required |
| Swaps | simulated pools | local test venue | — | external route adapters (blocked here) |

The label is shown at all times in the top bar. The server refuses dangerous mixes at startup (`apps/server/src/config.ts`): development attestors, local fixtures or a local RPC in production, and local settlement fixtures with a mainnet RPC.

## Live state

The indexer projects vaults, strategies, events, policies and pool reserves into Postgres. Every state change also writes an outbox row and `NOTIFY` in the same transaction; the API fans topics out over SSE and the web app refetches the queries for those topics (TanStack Query). Transactions show their real lifecycle: signed → submitted → confirmed → finalized, or failed / expired with the reason.

## Limits

Plan bounds (`packages/core/src/limits.ts`) keep evaluation within one transaction's compute budget: ≤ 8 events, 24 nodes, 12 actions, 6 mints, 4 allocations, depth 8, 2,600 bytes. Observed: roughly 20–60k compute units per execution on localnet.
