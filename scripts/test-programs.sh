#!/usr/bin/env bash
# Full on-chain test run (LOCALNET ONLY):
#   1. host tests: pure logic + conformance with the TS engine, zero-copy layout pins
#   2. SBF build of maybe_vault + maybe_testvenue (anchor build), IDLs copied to the SDK
#   3. fresh solana-test-validator, localnet seed, SDK integration tests against real programs
# Set MAYBE_KEEP_VALIDATOR=1 to leave the validator running afterwards.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export PATH=/opt/solana/solana-release/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH
export NO_DNA=1
cd "$ROOT/programs"
echo "== host tests"
cargo test -p maybe-logic --release
cargo test -p maybe-vault --lib
echo "== SBF build"
mkdir -p target/deploy
cp keys/localnet/maybe_vault.json target/deploy/maybe_vault-keypair.json
cp keys/localnet/maybe_testvenue.json target/deploy/maybe_testvenue-keypair.json
anchor build
cp target/idl/maybe_vault.json target/idl/maybe_testvenue.json "$ROOT/packages/sdk/src/idl/"
cd "$ROOT"
echo "== local validator + seed"
bash scripts/validator.sh stop >/dev/null 2>&1 || true
bash scripts/validator.sh
npx tsx scripts/localnet-setup.ts
echo "== integration tests"
status=0
MAYBE_LOCALNET_TESTS=1 npx vitest run --project sdk || status=$?
[ "${MAYBE_KEEP_VALIDATOR:-0}" = "1" ] || bash scripts/validator.sh stop
exit $status
