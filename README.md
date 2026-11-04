# MAYBE — programmable futures for your money

Write down what should happen to your money if the world goes one way or another — "reserve 500 USDC; use 300 if A resolves YES, and 200 if B and C resolve YES; expire after 30 days" — see exactly where it can go across every possible outcome, sign it once, and watch a Solana program carry it out.

The plan you review compiles to a bounded binary plan that the vault program itself evaluates. A backend or an agent can submit instructions, but only the program decides what moves.

> **Status.** Runs in two environments: an in-browser **simulation** (no chain, sample data) and a **local Solana validator** with real programs, test tokens, an API server and workers. Nothing is deployed to devnet or mainnet; no real funds move; no token was launched. Live venues (Polymarket, Kalshi/DFlow, Jupiter, PumpSwap) are externally blocked here — see [the feature matrix](docs/FEATURE_MATRIX.md).

## Quick start

Requirements: Node ≥ 22.22, pnpm 10. For the chain path also PostgreSQL 16, the Solana CLI (Agave 4.x) and Anchor 1.2.

```bash
pnpm install

# 1. the app in simulation mode (everything in the browser)
pnpm dev                       # http://127.0.0.1:5173

# 2. the full local stack: validator + Postgres + API/worker + web, one command
docker compose up -d db        # or any local Postgres with role maybe / maybe-local-dev
pnpm dev:local                 # http://127.0.0.1:5173 talking to http://127.0.0.1:8787
```

In local-stack mode, **Connect** creates a local development wallet in your browser (labelled as such; the server refuses it anywhere but localnet) and funds it with test SOL, USDC and MAYBE. Open any market to resolve it with the local development attestors.

## Tests

```bash
pnpm test                          # core, agent, sdk (unit), server (needs Postgres), web
bash scripts/test-programs.sh      # Rust logic + conformance, SBF build, fresh validator, SDK integration
pnpm e2e:chain                     # API + workers + programs end to end → docs/evidence/e2e-chain.md
pnpm --filter @maybe/web e2e       # Playwright: flows, keyboard, axe (WCAG 2.2 AA), safety, responsive, perf
```

What each suite proves is listed in [docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md); the end-to-end run's observed results are in [docs/evidence/e2e-chain.md](docs/evidence/e2e-chain.md); browser QA in [docs/QA.md](docs/QA.md).

## Repository

```
packages/core     strategy language, plan format, predicate semantics, engine, ledger, simulator, templates
packages/api      web ↔ backend contract and shared view builders
packages/agent    agent roles, tool allowlists, injection boundary, local assistant, model adapter
packages/sdk      Solana client: PDAs, instructions, decoders, attestations
programs/         maybe_vault (Anchor), maybe_testvenue (local only), maybe-logic (shared Rust semantics)
apps/server       API (Hono) + worker: auth, intents, tx pipeline, indexer, keeper, settlement, reconciliation
apps/web          React app: Overview, Discover, Futures (sentence/graph/list), Review, Money, Agents, Rooms
scripts/          validator, localnet seed, end-to-end, dev stack, deploy (prepared for review)
docs/             research, architecture, threat model, semantics, invariants, decisions, deployment
```

## Read next

- [Architecture](docs/ARCHITECTURE.md) — what runs where and who enforces what
- [Strategy semantics](docs/STRATEGY_SEMANTICS.md) — the language, precisely
- [On-chain invariants](docs/ONCHAIN_INVARIANTS.md) — what the program guarantees and the test for each
- [Threat model](docs/THREAT_MODEL.md)
- [Interface contract](docs/INTERFACE_CONTRACT.md) — PDAs, plan layout, instructions, attestation messages
- [Decisions](docs/DECISIONS.md) · [Deployment checklist](docs/DEPLOYMENT.md) · [Research](docs/RESEARCH.md)

## Honesty notes

- Markets, prices and sample futures are fictional fixtures and are labelled "Sample" wherever they appear.
- Outcomes on localnet are signed by **development attestors** (2 of 3 keys that exist only on this machine). A trusted attestation is labelled as trusted; a threshold doesn't remove correlated failure.
- The agents run a clearly labelled deterministic local assistant unless a model key is configured. No agent has a tool that moves money.
- No audit has been performed.
