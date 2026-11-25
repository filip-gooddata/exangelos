#!/usr/bin/env bash
# Fails when any file in the given paths carries a signature from a signing identity, such as the Developer ID that
# signs the tray app. The core binaries and the connectors ship ad hoc signed or unsigned, so no file in them may show an
# Authority. A .tar.gz is unpacked and its files checked; a folder is checked file by file. With --adhoc, each path must
# also be a file with an ad hoc signature.
#
# Usage: check-no-developer-id.sh [--adhoc] <path>...
set -euo pipefail

adhoc=false
if [ "${1:-}" = --adhoc ]; then adhoc=true; shift; fi
test "$#" -gt 0 || { echo "no paths to check" >&2; exit 2; }
command -v codesign > /dev/null || { echo "codesign is not available" >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
files=0
signed=0
found=0

# Prints the signature details of a file, nothing for a file that is not signed, and fails on any other codesign error.
details_of() {
  local details
  if details=$(codesign -dvv "$1" 2>&1); then
    printf '%s\n' "$details"
  elif [ "$details" != "$1: code object is not signed at all" ]; then
    echo "codesign could not read $1: $details" >&2
    return 1
  fi
}

check_file() {
  local details
  details=$(details_of "$1")
  files=$((files + 1))
  if $adhoc && ! grep -qx 'Signature=adhoc' <<< "$details"; then
    echo "$2 has no ad hoc signature" >&2
    found=$((found + 1))
  fi
  test -n "$details" || return 0
  signed=$((signed + 1))
  if grep -q '^Authority=' <<< "$details"; then
    echo "$2 carries a signature from a signing identity:" >&2
    grep -E '^(Authority|TeamIdentifier)=' <<< "$details" >&2
    found=$((found + 1))
  fi
}

check_tree() {
  local list="$work/list.$RANDOM"
  find "$1" -type f -print0 > "$list"
  while IFS= read -r -d '' file; do
    check_file "$file" "$2${file#"$1"}"
  done < "$list"
}

for path in "$@"; do
  if $adhoc; then
    test -f "$path" || { echo "$path is not a file" >&2; exit 1; }
    check_file "$path" "$path"
  elif [ -d "$path" ]; then
    check_tree "$path" "$path"
  elif [[ "$path" == *.tar.gz ]]; then
    unpacked=$(mktemp -d "$work/unpacked.XXXXXX")
    tar -xzf "$path" -C "$unpacked"
    check_tree "$unpacked" "$path:"
  elif [ -f "$path" ]; then
    check_file "$path" "$path"
  else
    echo "$path does not exist" >&2
    exit 1
  fi
done

echo "Checked $files files in $# paths; $signed signed, $found with a problem" >&2
test "$found" -eq 0
