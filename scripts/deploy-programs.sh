#!/usr/bin/env bash
# Deploy maybe_vault to a public cluster. PREPARED FOR REVIEW — read docs/DEPLOYMENT.md first.
#
#   scripts/deploy-programs.sh --cluster devnet \
#     --program-keypair /secure/maybe_vault-program.json \
#     --upgrade-authority /secure/upgrade-authority.json \
#     --payer /secure/deployer.json \
#     --treasury-owner <pubkey> --max-fee-bps 50 \
#     --i-have-reviewed
#
# Refuses: the localnet fixture keys, maybe_testvenue, mainnet without an explicit second confirmation,
# and a program id that doesn't match declare_id! in the source.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export PATH=/opt/solana/solana-release/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH
export NO_DNA=1

CLUSTER="" PROGRAM_KP="" UPGRADE_KP="" PAYER_KP="" TREASURY="" MAX_FEE="" REVIEWED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) CLUSTER=$2; shift 2 ;;
    --program-keypair) PROGRAM_KP=$2; shift 2 ;;
    --upgrade-authority) UPGRADE_KP=$2; shift 2 ;;
    --payer) PAYER_KP=$2; shift 2 ;;
    --treasury-owner) TREASURY=$2; shift 2 ;;
    --max-fee-bps) MAX_FEE=$2; shift 2 ;;
    --i-have-reviewed) REVIEWED=1; shift ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done

die() { echo "refusing: $*" >&2; exit 1; }
[ "$REVIEWED" = 1 ] || die "pass --i-have-reviewed after reading docs/DEPLOYMENT.md"
case "$CLUSTER" in
  devnet) URL=https://api.devnet.solana.com ;;
  mainnet-beta)
    [ "${MAYBE_ALLOW_MAINNET:-}" = "I_UNDERSTAND_THIS_HOLDS_REAL_VALUE" ] || die "mainnet needs MAYBE_ALLOW_MAINNET=I_UNDERSTAND_THIS_HOLDS_REAL_VALUE (and an audit)"
    URL=https://api.mainnet-beta.solana.com ;;
  *) die "--cluster must be devnet or mainnet-beta" ;;
esac
for f in "$PROGRAM_KP" "$UPGRADE_KP" "$PAYER_KP"; do
  [ -n "$f" ] && [ -f "$f" ] || die "missing keypair file: ${f:-<unset>}"
  case "$(cd "$(dirname "$f")" && pwd)" in "$ROOT"/programs/keys/localnet*) die "$f is a public localnet fixture key" ;; esac
done
[ -n "$TREASURY" ] || die "--treasury-owner is required"
[ -n "$MAX_FEE" ] && [ "$MAX_FEE" -le 100 ] || die "--max-fee-bps must be ≤ 100"

PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KP")
LOCAL_ID=$(solana-keygen pubkey "$ROOT/programs/keys/localnet/maybe_vault.json")
[ "$PROGRAM_ID" != "$LOCAL_ID" ] || die "program id equals the localnet fixture id"
grep -q "declare_id!(\"$PROGRAM_ID\")" "$ROOT/programs/programs/maybe-vault/src/lib.rs" || die "declare_id! in maybe-vault/src/lib.rs is not $PROGRAM_ID (update it, rebuild, re-test on localnet)"

echo "== plan"
echo "cluster:            $CLUSTER ($URL)"
echo "program id:         $PROGRAM_ID"
echo "upgrade authority:  $(solana-keygen pubkey "$UPGRADE_KP")"
echo "payer:              $(solana-keygen pubkey "$PAYER_KP")"
echo "treasury owner:     $TREASURY"
echo "max fee cap (bps):  $MAX_FEE"
echo "dev attestors:      disabled right after init (one-way)"
read -r -p "Type the cluster name to continue: " confirm
[ "$confirm" = "$CLUSTER" ] || die "not confirmed"

echo "== build"
(cd "$ROOT/programs" && anchor build -p maybe_vault)
echo "== deploy"
solana program deploy --url "$URL" --keypair "$PAYER_KP" --program-id "$PROGRAM_KP" --upgrade-authority "$UPGRADE_KP" "$ROOT/programs/target/deploy/maybe_vault.so"
echo "== initialize (init_config is first-caller-wins: done immediately)"
node --import tsx "$ROOT/apps/server/scripts/init-config.ts" --url "$URL" --program-id "$PROGRAM_ID" --admin "$UPGRADE_KP" --treasury-owner "$TREASURY" --max-fee-bps "$MAX_FEE"
echo "done. Next: list assets, configure routes, create the production attestor set (docs/DEPLOYMENT.md)."
