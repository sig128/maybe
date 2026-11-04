#!/usr/bin/env bash
# Publish the public Odds board to GitHub Pages: the gh-pages branch of `origin`.
#
# Builds apps/web in public mode (the live board on its own, see apps/web/vite.config.ts) under
# /<repo>/ and force-pushes the output as one commit, so the branch only ever holds the current site.
#
#   bash scripts/deploy-pages.sh
#   PAGES_BASE=/ bash scripts/deploy-pages.sh        # when served from a domain root
#   PUBLISH_MESSAGE_EXTRA="..." bash scripts/...     # extra lines for the publish commit message
set -euo pipefail
cd "$(dirname "$0")/.."

remote_url=$(git remote get-url origin)
repo=$(basename -s .git "$remote_url")
base=${PAGES_BASE:-/$repo/}
source_sha=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to publish: commit your changes first, so the site matches a commit" >&2
  exit 1
fi

rm -rf apps/web/dist-public
(cd apps/web && VITE_PUBLIC_SITE=1 pnpm exec vite build --base="$base" --outDir dist-public --logLevel warn)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -R apps/web/dist-public/. "$tmp"/
message="Publish the live board from $source_sha"
if [ -n "${PUBLISH_MESSAGE_EXTRA:-}" ]; then
  message=$(printf '%s\n\n%s' "$message" "$PUBLISH_MESSAGE_EXTRA")
fi
git -C "$tmp" init -q -b gh-pages
git -C "$tmp" add -A
git -C "$tmp" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" commit -q -m "$message"
git -C "$tmp" push -q -f "$remote_url" gh-pages
echo "published $base from $source_sha"
