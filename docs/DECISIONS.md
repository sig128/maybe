# Decisions

Short records of choices that shape the build. Each is reversible unless it says otherwise.

## D1 · A bounded plan language the program can enforce, not a hashed document

**Choice.** Strategies compile to a canonical binary plan (`MYB1`, `packages/core/src/plan.ts`): fixed-size events, mints, refs, allocations, predicate nodes and actions, with reserved bytes zero and strict decoding. The program decodes and evaluates the same plan the user reviewed; the hash only proves which plan it is.

**Why.** Signing a hash of a JSON document proves nothing about what a worker later does with it. The program has to be able to check every spend against the plan: mints, routes, recipients, amounts, minimum received, fees, deadlines, branch exclusivity and outcome evidence.

**Consequence.** The language is deliberately bounded (`packages/core/src/limits.ts`: ≤ 8 events, 24 nodes, 12 actions, 6 mints, 4 allocations, depth 8, 2,600 bytes; acyclic; see `docs/STRATEGY_SEMANTICS.md`). Logic outside it is rejected at validation, never delegated to a trusted worker.

## D2 · One semantics, two implementations, shared fixtures

**Choice.** The TypeScript engine (`packages/core`) is the reference; the Rust crate (`programs/crates/maybe-logic`) is a port. `packages/core/scripts/write-conformance.ts` generates fixtures (plans, malformed plans, 400 predicate cases, 1,296 readiness/execution cases) that both must reproduce exactly.

**Why.** The simulator, the review screen and the program must agree on what a plan does, including unresolved, disputed and voided outcomes and deadline boundaries.

## D3 · Lazy finality and time-of-truth predicates

**Choice.** Each predicate node evaluates to `(t, f)`: the earliest time it is known true and known false. Attested outcomes are final at `finalAt` without a crank; balance events are final NO at `deadline + 1`; DISPUTED is never final; VOID makes outcome leaves false.

**Why.** Readiness can't depend on someone remembering to call `finalize`. Vetoes and delays need "known true since when", not just a boolean.

## D4 · Vite + React SPA instead of Next.js

**Choice.** `apps/web` is a Vite 8 / React 19 single-page app with react-router 8.

**Why.** There is no server rendering need: the app is behind a wallet, its data is per-user and live, and the backend is a separate typed API. A static build also deploys anywhere (the simulation needs no server at all). Next.js would add a second server runtime with no benefit here.

## D5 · `@solana/web3.js` 1.x line in the SDK

**Choice.** The SDK uses `@solana/web3.js` 1.99 and `@solana/spl-token` 0.4.

**Why.** Anchor 1.2's TypeScript ecosystem and spl-token still target the 1.x line; mixing in `@solana/kit` would double the transaction types for no gain at this size. Revisit when spl-token ships a kit-native release.

## D6 · Modular monolith: one API process, one worker process, Postgres as the bus

**Choice.** `apps/server` has two entry points (`main.ts`, `worker.ts`) sharing one codebase. Jobs, intents, projections and the outbox live in Postgres; workers coordinate with `FOR UPDATE SKIP LOCKED` leases, the API with `LISTEN/NOTIFY`.

**Why.** No speculative services. Both processes scale horizontally because every coordination point is in the database.

## D7 · Exactly-once spending comes from the chain, not the queue

**Choice.** Execute jobs are keyed `(strategy, action, run)`. The handler re-reads the strategy account before acting; the program requires `run` to equal its own counter and advances it in the same transaction.

**Why.** A job queue can redeliver; a crashed worker can't tell whether its transaction landed. The only authority on "did this run happen" is the chain. Proven by the crash-after-send and crash-before-send scenarios in `pnpm e2e:chain`.

## D8 · The wallet signs exact bytes; the server never holds user keys

**Choice.** The server compiles transactions with the user as fee payer and returns the message bytes; the wallet signs them; the server verifies the signature against those bytes before sending (`Chain.attach`). Agent automation uses a separate session key bounded by an on-chain policy.

**Why.** The user's signature has to cover exactly what was reviewed, and a compromised server must not be able to spend. On localnet the session keys live in `.localnet/session-keys`; production needs a KMS/HSM (refused otherwise).

## D9 · Trusted attestation is labelled as trusted

**Choice.** Off-chain outcomes resolve through an attestor set: k-of-n Ed25519 signatures over a domain-separated message with rule hash, outcome, nonce and expiry, a challenge window, dispute → adjudication (super-threshold) or VOID on timeout. Development sets are flagged on-chain (`is_dev`) and can be disabled for good.

**Why.** Posting HTTP data on-chain doesn't make it trustless. The UI says "trusted attestation · 2 of 3 development signers" wherever it applies; the objective balance adapter says "objective · read on-chain".

## D10 · Probability triggers are deferred

**Choice.** No automatic spending on price/probability thresholds.

**Why.** It needs depth-aware executable prices, stale-data limits, manipulation analysis and a defined observation window (master brief §11). None of the venues' data can be enforced on-chain here; a spot percentage alone isn't acceptable. Feature-gated off and listed in the feature matrix.

## D11 · Local test venue for swaps; mainnet routes externally blocked

**Choice.** Swaps execute through `maybe_testvenue` (constant-product pools and an outcome market, plus deliberately malicious pools) under route kinds the vault validates generically: program ownership, mint pair, no vault-owned accounts in the route slice, balance deltas, minimum received.

**Why.** This environment has no mainnet RPC or program access, so Jupiter, PumpSwap and Pump bonding curves can't be cloned or exercised. The vault's route checks don't depend on the venue; a production adapter adds a route kind and its account-slice rules (`docs/ONCHAIN_INVARIANTS.md`).

## D12 · Sample data is always labelled

**Choice.** Fixture markets are fictional, quotes are deterministic samples tagged "Sample", sample futures and rooms carry a sample badge, and rooms distinguish live / paper / backtest / none.

**Why.** No fabricated followers, returns or volume (master brief §8).

## D13 · Odds reads mainnet from the browser; positions are practice-only

**Choice.** The live board connects straight from the visitor's browser to public sources: PumpPortal's websocket for launches and graduations, a public Solana RPC (PublicNode) for curve and pool accounts, Jupiter for stats. No server sits in between. The odds are a model line, labelled as such, and positions use practice SOL stored in the browser.

**Why.** Reading public chain state needs no keys and no backend, and a browser connection is as fast as the data gets. Taking real stakes would make MAYBE a market operator: that needs an audited on-chain market program, a license, and a resolution source people can rely on. None of those exist yet, so real money is off, and the page says so.

## D14 · The public board is published on GitHub Pages, not through a hosting account's Git integration

**Choice.** `scripts/deploy-pages.sh` builds the board in public mode (`odds.html` only: no simulation, no wallet, a Content-Security-Policy) and force-pushes it as a single commit to the `gh-pages` branch, which GitHub Pages serves.

**Why.** The repository is public. A hosting provider's Git integration posts deployment links back onto every commit, and those links carry the hosting account's own team name. Publishing from the repository itself keeps the public footprint to the repository and its Pages URL. The build is static, so moving it to another host later is a copy.
