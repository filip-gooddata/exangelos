#!/usr/bin/env bash
# Publishes the GitHub release for a tag claim-version.sh created, with the given files, and tries again when GitHub
# fails. Running it again is safe: once the release is published, a later try or rerun uploads the files over the
# ones it has, and a draft a failed try left behind is deleted first. The release is marked latest only when no
# higher version is published, as a rerun of an older run may publish after a newer one.
#
# Usage: publish-release.sh <tag> <file>...
# Environment: GITHUB_REPOSITORY, and GH_TOKEN allowed to write contents.
set -euo pipefail
. "$(dirname "$0")/github.sh"

tag=$1
shift
repo=$GITHUB_REPOSITORY

latest() {
  local newest
  if ! newest=$(gh api "repos/$repo/releases/latest" --jq .tag_name 2>&1); then
    case $newest in
      *"HTTP 404"*) echo true; return 0 ;;
    esac
    echo "$newest" >&2
    return 1
  fi
  if [ "$(printf '%s\n%s\n' "$newest" "$tag" | highest_version)" = "$tag" ]; then echo true; else echo false; fi
}

publish() {
  local state=0 drafts id mark
  release_published "$tag" || state=$?
  case $state in
    0)
      echo "$tag is published; uploading the files over its own"
      gh release upload "$tag" "$@" --repo "$repo" --clobber
      ;;
    1)
      drafts=$(gh api "repos/$repo/releases?per_page=100" --jq ".[] | select(.draft and .tag_name == \"$tag\") | .id") || return 1
      for id in $drafts; do
        echo "Deleting the draft release $id a failed try left for $tag"
        gh api -X DELETE "repos/$repo/releases/$id" --silent || return 1
      done
      mark=$(latest) || return 1
      gh release create "$tag" "$@" --repo "$repo" --verify-tag --title "$tag" --generate-notes --latest="$mark"
      ;;
    *) return 1 ;;
  esac
}

retry publish "$@"
