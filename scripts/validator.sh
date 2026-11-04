#!/usr/bin/env bash
# Local solana-test-validator with maybe_vault + maybe_testvenue preloaded (LOCALNET ONLY).
#   scripts/validator.sh          start (idempotent; resets the ledger unless MAYBE_KEEP_LEDGER=1)
#   scripts/validator.sh stop     stop it
#   scripts/validator.sh status   print health
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export PATH=/opt/solana/solana-release/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH
RPC_PORT=${MAYBE_RPC_PORT:-8899}
STATE=$ROOT/.localnet
mkdir -p "$STATE"
health() { curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "http://127.0.0.1:$RPC_PORT" 2>/dev/null | grep -q '"ok"'; }
case "${1:-start}" in
  stop)
    if [ -f "$STATE/validator.pid" ]; then kill "$(cat "$STATE/validator.pid")" 2>/dev/null || true; rm -f "$STATE/validator.pid"; fi
    pkill -f "solana-test-validator.*$STATE/ledger" 2>/dev/null || true
    echo "validator stopped"; exit 0 ;;
  status)
    if health; then echo "validator healthy on :$RPC_PORT"; else echo "validator not running"; exit 1; fi; exit 0 ;;
esac
if health; then echo "validator already running on :$RPC_PORT"; exit 0; fi
SO=$ROOT/programs/target/deploy
if [ ! -f "$SO/maybe_vault.so" ] || [ ! -f "$SO/maybe_testvenue.so" ]; then echo "programs not built: run (cd programs && anchor build)"; exit 1; fi
VAULT_ID=$(solana-keygen pubkey "$ROOT/programs/keys/localnet/maybe_vault.json")
VENUE_ID=$(solana-keygen pubkey "$ROOT/programs/keys/localnet/maybe_testvenue.json")
RESET=--reset; [ "${MAYBE_KEEP_LEDGER:-0}" = "1" ] && RESET=
nohup solana-test-validator $RESET --quiet --ledger "$STATE/ledger" --rpc-port "$RPC_PORT" \
  --bpf-program "$VAULT_ID" "$SO/maybe_vault.so" \
  --bpf-program "$VENUE_ID" "$SO/maybe_testvenue.so" > "$STATE/validator.log" 2>&1 &
echo $! > "$STATE/validator.pid"
for _ in $(seq 1 90); do if health; then echo "validator healthy on :$RPC_PORT (vault $VAULT_ID, venue $VENUE_ID)"; exit 0; fi; sleep 1; done
echo "validator did not become healthy; see $STATE/validator.log"; tail -20 "$STATE/validator.log"; exit 1
