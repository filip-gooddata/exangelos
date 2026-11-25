#!/usr/bin/env bash
# Checks that each path carries a valid signature from the given Developer ID identity, nested code included, with the
# hardened runtime and a secure timestamp, and prints the lines of the signature that show it.
#
# Usage: verify-macos-signature.sh <identity> <path>...
set -euo pipefail

identity=$1
shift
for path in "$@"; do
  codesign --verify --strict --deep --verbose=2 "$path"
  details=$(codesign -dvv "$path" 2>&1)
  grep -E '^(Identifier|CodeDirectory|Authority|Timestamp|TeamIdentifier)=?' <<< "$details" || true
  grep -qxF "Authority=$identity" <<< "$details" || { echo "$path is not signed by the expected identity" >&2; exit 1; }
  grep -qE '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime' <<< "$details" || { echo "$path lacks the hardened runtime" >&2; exit 1; }
  grep -q '^Timestamp=' <<< "$details" || { echo "$path lacks a secure timestamp" >&2; exit 1; }
done
