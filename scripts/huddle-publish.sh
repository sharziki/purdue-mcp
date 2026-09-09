#!/usr/bin/env bash
# Refresh the Huddle mirror and publish it to the repo's `data` branch.
#
# Must run from a residential connection. Vercel's challenge is IP-reputation
# gated: the same headless browser that sails through here sits on the
# "Vercel Security Checkpoint" forever from a datacenter address, which is why
# this is a laptop timer and not a GitHub Action (see README).
#
# The branch is one orphan commit, force-pushed each run, so refreshing a
# ~1.7 MB file every half hour never grows the repo's history.
set -euo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REMOTE=${HUDDLE_REMOTE:-$(git -C "$REPO_DIR" remote get-url origin)}
BRANCH=${HUDDLE_BRANCH:-data}

# puppeteer resolves its own download unless npm blocked the postinstall.
if [[ -z ${PUPPETEER_EXECUTABLE_PATH:-} ]]; then
  chrome=$(ls -d "$HOME"/.cache/puppeteer/chrome/*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1 || true)
  [[ -n $chrome ]] && export PUPPETEER_EXECUTABLE_PATH="$chrome"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

node "$REPO_DIR/scripts/huddle-mirror.mjs" --out "$work/huddle-purdue.json"

cd "$work"
git init -q
git config user.name "sharziki"
git config user.email "sharziki@users.noreply.github.com"
git add huddle-purdue.json
git commit -q -m "Huddle mirror $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q --force "$REMOTE" "HEAD:$BRANCH"
echo "published $(du -h huddle-purdue.json | cut -f1) to $BRANCH"
