# Helpers the release scripts and workflow steps source. GitHub's API and git hosting fail now and then with a 403, a 502
# or a dropped connection that the next try gets through, so the release retries each network call.

# Runs a command until it succeeds, at most RETRY_ATTEMPTS times (default 5), waiting RETRY_DELAY seconds (default 5)
# and twice as long after each failure. A function run this way runs without `set -e`, so it returns on failure itself.
retry() {
  local attempts=${RETRY_ATTEMPTS:-5} delay=${RETRY_DELAY:-5} attempt=1
  until "$@"; do
    if [ "$attempt" -ge "$attempts" ]; then
      echo "Failed $attempts times: $*" >&2
      return 1
    fi
    echo "Try $attempt of $attempts failed: $*; trying again in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

# Whether the tag has a published release in GITHUB_REPOSITORY: 0 when it has, 1 when it has not and 2 when the API
# did not answer.
release_published() {
  local answer
  if answer=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$1" --jq .tag_name 2>&1); then
    return 0
  fi
  case $answer in
    *"HTTP 404"*) return 1 ;;
  esac
  echo "$answer" >&2
  return 2
}

# The highest vX.Y.Z of the lines on stdin.
highest_version() {
  { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } | sort -V | tail -n1
}
