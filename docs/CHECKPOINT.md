# Checkpoint

Working notes for whoever picks this up next (including a future session). Updated as work lands.

## Done

| Area | Where | Evidence |
|---|---|---|
| Research note, integrations | `docs/RESEARCH.md`, `docs/research/INTEGRATIONS.md` | dated sources inside |
| Interface contract | `docs/INTERFACE_CONTRACT.md` | normative for SDK ↔ programs ↔ server |
| Strategy engine (TS) | `packages/core` | `npx vitest run --project core` (110 tests incl. property tests) |
| Solana programs + shared Rust logic | `programs/` | `bash scripts/test-programs.sh` (12 Rust + 17 SDK tests, 12 on a live validator) |
| SDK | `packages/sdk` | as above |
| API contract + view builders | `packages/api` | shared by browser simulation and server |
| Web app | `apps/web` | `npx vitest run --project web`; Playwright flows (see below) |
| Agents (deterministic local assistant + model adapter) | `packages/agent` | `npx vitest run --project agent` |
| Server: auth, intents, tx pipeline, indexer, keeper, settlement, reconciliation, SSE | `apps/server` | `npx vitest run --project server` (Postgres) |
| Local-validator end-to-end | `apps/server/scripts/e2e-chain.ts` | `pnpm e2e:chain` → `docs/evidence/e2e-chain.md` |

## Commands

```
pnpm install
pnpm test                         # all unit/property/integration suites (server suite needs Postgres)
bash scripts/test-programs.sh     # Rust + SBF build + validator + SDK integration
pnpm e2e:chain                    # API + workers + programs end to end (fresh validator)
pnpm dev                          # web app in simulation mode (no chain)
pnpm dev:local                    # validator + Postgres + API/worker + web against localnet
```

Toolchain notes: Solana CLI lives at `/opt/solana/solana-release/bin` (scripts add it to PATH themselves; never edit shell profiles). Anchor CLI needs `NO_DNA=1`. Postgres role `maybe` / `maybe-local-dev` (local only).

## Decisions

See `docs/DECISIONS.md`.

## Remaining

Tracked in `docs/FEATURE_MATRIX.md` under "deferred" and "externally blocked".
