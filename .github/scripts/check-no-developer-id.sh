#!/usr/bin/env bash
# Fails when any file in the given paths carries a signature from a signing identity, such as the Developer ID that
# signs the tray app. The core binaries and the connectors ship ad hoc signed or unsigned, so no file in them may show an
# Authority. A .tar.gz is unpacked and its files checked; a folder is checked file by file.
#
# Usage: check-no-developer-id.sh <path>...
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
checked=0
found=0

check_file() {
  local details
  details=$(codesign -dvv "$1" 2>&1) || return 0
  checked=$((checked + 1))
  if grep -q '^Authority=' <<< "$details"; then
    echo "$2 carries a signature from a signing identity:" >&2
    grep -E '^(Authority|TeamIdentifier)=' <<< "$details" >&2
    found=$((found + 1))
  fi
}

check_tree() {
  while IFS= read -r -d '' file; do
    check_file "$file" "$2${file#"$1"}"
  done < <(find "$1" -type f -print0)
}

for path in "$@"; do
  if [ -d "$path" ]; then
    check_tree "$path" "$path"
  elif [[ "$path" == *.tar.gz ]]; then
    unpacked=$(mktemp -d "$work/unpacked.XXXXXX")
    tar -xzf "$path" -C "$unpacked"
    check_tree "$unpacked" "$path:"
  else
    check_file "$path" "$path"
  fi
done

echo "Checked $# paths; $checked signed files, none from a signing identity" >&2
test "$found" -eq 0
