# Deployment (prepared for review — not performed)

Nothing in this repository has been deployed to devnet or mainnet, no Pump token was created, and no real funds were moved. This page lists what a deliberate deployment needs and what the prepared scripts do. Treat it as a checklist for a reviewer, not as instructions to run blindly.

## What can be deployed today

| Piece | Ready? | Notes |
|---|---|---|
| Web app in simulation mode | Yes | Static build (`pnpm build` → `apps/web/dist`). No backend, no keys, sample data only. Safe to host anywhere. |
| Web app against an API | Partly | Needs a real wallet adapter (Wallet Standard) instead of the local dev wallet, which the server refuses outside localnet. |
| API + worker | Code ready | Needs Postgres, a non-local RPC, a keeper key, and an address book for the target cluster (see below). |
| `maybe_vault` program | Code ready | Needs new program keys, an upgrade-authority policy, a reviewed config and attestor set, and an audit before holding real value. |
| `maybe_testvenue` | Local only | Never deploy it outside a test cluster: its pools exist to test malicious routes. |

## Program deployment checklist

1. **Keys.** Generate a new program keypair and an upgrade-authority keypair *outside* this repository. `programs/keys/localnet/*` are public test keys and are refused by `scripts/deploy-programs.sh`.
2. **Program ID.** Update `declare_id!` in `programs/programs/maybe-vault/src/lib.rs`, `programs/Anchor.toml`, and the `ProgramIds` you pass to `MaybeClient`; rebuild (`anchor build`) and re-run `bash scripts/test-programs.sh` on localnet with the new ID.
3. **Upgrade authority.** Decide: a multisig (recommended), or make the program immutable after review. Record the decision.
4. **Initialize immediately.** `init_config` is first-caller-wins. Deploy and initialize in one operator session (`deploy-programs.sh` does both, in that order).
5. **Config.** `max_fee_bps_cap`, treasury owner, **`allow_dev_attestors = false`** on any cluster that can hold value (call `disable_dev_attestors`, which is one-way).
6. **Assets.** List only mints that pass the extension allowlist (`docs/ONCHAIN_INVARIANTS.md` §16). For devnet, use devnet USDC.
7. **Routes.** A production swap route needs its own adapter (route kind + account-slice rules) and tests against real program accounts. Jupiter and PumpSwap adapters are **not implemented** (externally blocked here, see `docs/FEATURE_MATRIX.md`).
8. **Attestors.** A production attestor set: named operators, independent keys (HSM), threshold, adjudication threshold, challenge window, dispute timeout, revocation procedure. Publish it; label it "trusted attestation" in the UI.
9. **Events.** Create outcome events for each supported market and rule version (`create_event` is permissionless; plans pin exact event accounts).
10. **Audit.** No third-party audit has been done. Don't hold real value before one.

## Server deployment checklist

- `MAYBE_MODE=devnet` (or `production` once supported); the server refuses development attestors, local address books and local RPCs in production, and local fixtures with a mainnet RPC in any mode.
- `DATABASE_URL` with a real password; run `pnpm db:migrate`.
- `RPC_URL` to a dedicated provider with `getProgramAccounts` enabled.
- `KEEPER_KEYPAIR` funded with SOL for fees only (the keeper never holds user funds).
- An address book for the cluster (the localnet one is written by `scripts/localnet-setup.ts`; a devnet equivalent must be produced by a reviewed setup script — not written yet).
- Agent session keys: a KMS/HSM integration. The server refuses server-held session keys outside localnet.
- TLS termination, `WEB_ORIGIN` and `AUTH_DOMAIN` set to the real site.

## Scripts

- `scripts/deploy-programs.sh` — builds, checks the keys aren't the localnet fixtures, prints the plan, and only then deploys and initializes. Requires `--cluster devnet` and `--i-have-reviewed`; refuses `mainnet-beta` unless `MAYBE_ALLOW_MAINNET=I_UNDERSTAND_THIS_HOLDS_REAL_VALUE` is set as well.
- `scripts/validator.sh`, `scripts/localnet-setup.ts` — local only; setup refuses a non-local RPC.
