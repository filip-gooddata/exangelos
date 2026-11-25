#!/usr/bin/env bash
# Publishes the GitHub release for a tag claim-version.sh created, with the given files, and tries again when GitHub
# fails. Running it again is safe: once the release is published, a later try or rerun uploads only the files it lacks
# or holds half uploaded and never replaces one it has, and a draft a failed try left behind is deleted first. The release is marked latest only when no
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

complete() {
  local have file line id
  have=$(gh api "repos/$repo/releases/tags/$tag" --jq '.assets[] | [.name, .state, .id] | @tsv') || return 1
  for file in "$@"; do
    line=$(awk -F '\t' -v name="$(basename "$file")" '$1 == name' <<< "$have")
    if [ "$(cut -f2 <<< "$line")" = uploaded ]; then
      continue
    fi
    if [ -n "$line" ]; then
      id=$(cut -f3 <<< "$line")
      gh api -X DELETE "repos/$repo/releases/assets/$id" --silent || return 1
    fi
    gh release upload "$tag" "$file" --repo "$repo" || return 1
  done
}

publish() {
  local state=0 drafts id mark
  release_published "$tag" || state=$?
  case $state in
    0)
      echo "$tag is published; uploading the files it lacks"
      complete "$@"
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
