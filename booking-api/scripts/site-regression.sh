#!/usr/bin/env bash
# Public website regression: the Astro build output on this branch must be byte-identical to main's.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WT=$(mktemp -d)/main
cd "$ROOT"
git worktree add -q "$WT" main
trap 'git -C "$ROOT" worktree remove --force "$WT"' EXIT
[ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null 2>&1
ln -s "$ROOT/node_modules" "$WT/node_modules"
(cd "$WT" && npm run build >/dev/null 2>&1)
sums() { (cd "$1" && find dist -type f | sort | xargs sha256sum); }
if diff <(sums "$ROOT") <(sums "$WT") >/dev/null; then
  echo "SITE REGRESSION: PASS ($(sums "$ROOT" | wc -l) files identical to main)"
else
  echo "SITE REGRESSION: FAIL"; diff <(sums "$ROOT") <(sums "$WT") | head; exit 1
fi
