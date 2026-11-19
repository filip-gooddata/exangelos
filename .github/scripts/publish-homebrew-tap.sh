#!/usr/bin/env bash
# Pushes a rendered Homebrew formula to the tap repository as Formula/exangelos.rb, committing only when it changed.
#
# Usage: publish-homebrew-tap.sh <formula file> <version>
# Environment: HOMEBREW_TAP_DEPLOY_KEY, the private half of the tap's write deploy key.
#              TAP_REPOSITORY, owner/name of the tap (default filip-gooddata/homebrew-exangelos).
#              DRY_RUN=true runs `git push --dry-run` instead of pushing.
set -euo pipefail

formula=$(realpath "$1")
version=$2
tap=${TAP_REPOSITORY:-filip-gooddata/homebrew-exangelos}
test -s "$formula"
test -n "${HOMEBREW_TAP_DEPLOY_KEY:-}" || { echo "HOMEBREW_TAP_DEPLOY_KEY is not set" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(umask 077 && printf '%s\n' "$HOMEBREW_TAP_DEPLOY_KEY" > "$work/key")
curl -fsSL https://api.github.com/meta | jq -r '.ssh_keys[] | "github.com " + .' > "$work/known_hosts"
test -s "$work/known_hosts"
export GIT_SSH_COMMAND="ssh -i $work/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$work/known_hosts"

git clone --depth 1 "git@github.com:$tap.git" "$work/tap"
cd "$work/tap"
mkdir -p Formula
cp "$formula" Formula/exangelos.rb
git add Formula/exangelos.rb
if git diff --cached --quiet; then
  echo "Formula/exangelos.rb is unchanged; nothing to push"
  exit 0
fi
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -m "exangelos $version"
if [ "${DRY_RUN:-false}" = true ]; then
  git push --dry-run origin HEAD:main
else
  git push origin HEAD:main
fi
