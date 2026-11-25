#!/usr/bin/env bash
# Pushes the rendered Homebrew formula and cask to the tap repository as Formula/exangelos.rb and Casks/exangelos-app.rb,
# committing only when they changed. A cask without checksums, rendered for a release without the macOS disk images,
# stays out of the tap.
#
# Usage: publish-homebrew-tap.sh <rendered tap directory> <version>
# Environment: HOMEBREW_TAP_DEPLOY_KEY, the private half of the tap's write deploy key.
#              TAP_REPOSITORY, owner/name of the tap (default filip-gooddata/homebrew-exangelos).
#              DRY_RUN=true runs `git push --dry-run` instead of pushing.
set -euo pipefail

rendered=$(realpath "$1")
version=$2
tap=${TAP_REPOSITORY:-filip-gooddata/homebrew-exangelos}
test -s "$rendered/Formula/exangelos.rb"
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
if [ -f Formula/exangelos.rb ]; then
  current=$(sed -n 's/^  version "\(.*\)"$/\1/p' Formula/exangelos.rb)
  if [ -n "$current" ] && [ "$current" != "$version" ] &&
    [ "$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -n1)" = "$current" ]; then
    echo "The tap already has exangelos $current, newer than $version; leaving it"
    exit 0
  fi
fi
cp "$rendered/Formula/exangelos.rb" Formula/exangelos.rb
git add Formula/exangelos.rb
if grep -q 'sha256 :no_check' "$rendered/Casks/exangelos-app.rb"; then
  echo "The release has no macOS disk images; leaving the cask out"
else
  mkdir -p Casks
  cp "$rendered/Casks/exangelos-app.rb" Casks/exangelos-app.rb
  git add Casks/exangelos-app.rb
fi
if git diff --cached --quiet; then
  echo "The formula and the cask are unchanged; nothing to push"
  exit 0
fi
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -m "exangelos $version"
if [ "${DRY_RUN:-false}" = true ]; then
  git push --dry-run origin HEAD:main
else
  git push origin HEAD:main
fi
