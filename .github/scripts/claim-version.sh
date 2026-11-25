#!/usr/bin/env bash
# Picks the version a release run publishes and claims its tag on GitHub before anything is built. Creating a tag that
# exists fails, so two release runs never take the same version, and a rerun keeps the version its first attempt
# claimed however many runs released meanwhile.
#
# - The commit has a version tag: with a published release there is nothing to build (skip=true, and publish-tap
#   repairs the tap); without one an earlier attempt claimed it, and this run releases it.
# - A later commit has a version tag: a later run took over, as it releases everything this commit has. With that
#   release published there is nothing to do (skip=true, no tag); without one the run fails and names the run to
#   rerun, rather than release this older commit under a higher version.
# - Otherwise the latest vX.Y.Z tag plus a patch bump, or a minor or major one for #minor or #major in a commit
#   message since that tag, becomes a tag on the commit. A run that loses the tag to another fetches the tags and
#   takes the next version. The first release is v0.1.0.
#
# Environment: GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_OUTPUT, and GH_TOKEN allowed to write contents. Run in a full
# clone whose origin is the repository.
set -euo pipefail
. "$(dirname "$0")/github.sh"

sha=$GITHUB_SHA

output() {
  { echo "tag=$1"; echo "version=${1#v}"; echo "skip=$2"; } >> "$GITHUB_OUTPUT"
}

claim() {
  local own later last next state=0
  git fetch --quiet --force --tags origin || return 1
  own=$(git tag --points-at "$sha" | highest_version)
  if [ -n "$own" ]; then
    release_published "$own" || state=$?
    case $state in
      0) echo "$sha is already released as $own"; output "$own" true ;;
      1) echo "$sha already has the tag $own, without a release yet; releasing it"; output "$own" false ;;
      *) return 1 ;;
    esac
    return 0
  fi
  later=$(git tag --contains "$sha" | highest_version)
  if [ -n "$later" ]; then
    release_published "$later" || state=$?
    case $state in
      0)
        echo "$later, on a later commit than $sha, is released with this commit's changes; nothing to do"
        output "" true
        return 0
        ;;
      1)
        echo "$later is claimed for $(git rev-list -n1 "$later"), a later commit than $sha, but not released;" \
          "rerun the release run of that commit, which releases this commit's changes too" >&2
        exit 1
        ;;
      *) return 1 ;;
    esac
  fi
  last=$(git tag --list | highest_version)
  if [ -z "$last" ]; then
    next=v0.1.0
  else
    local major minor patch log
    IFS=. read -r major minor patch <<< "${last#v}"
    log=$(git log --format=%B "$last..$sha") || return 1
    if grep -q '#major' <<< "$log"; then
      next="v$((major + 1)).0.0"
    elif grep -q '#minor' <<< "$log"; then
      next="v$major.$((minor + 1)).0"
    else
      next="v$major.$minor.$((patch + 1))"
    fi
  fi
  echo "${last:-none} -> $next"
  gh api "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$next" -f sha="$sha" --silent || return 1
  output "$next" false
}

retry claim
