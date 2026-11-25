#!/usr/bin/env bash
# Imports the Developer ID certificate into a new keychain for this job and puts that keychain first on the search list,
# so codesign and the Tauri bundler find the identity. Remove it afterwards with `security delete-keychain <keychain>`.
#
# Usage: import-signing-certificate.sh <keychain>
# Environment: APPLE_CERTIFICATE, base64 of a .p12 holding the certificate and its private key.
#              APPLE_CERTIFICATE_PASSWORD, the password of the .p12.
#              APPLE_SIGNING_IDENTITY, the identity the keychain must then hold, such as
#              "Developer ID Application: Example Corporation (TEAMID1234)".
set -euo pipefail

keychain=$1
for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY; do
  test -n "${!name:-}" || { echo "$name is not set" >&2; exit 1; }
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
password=$(openssl rand -hex 24)
echo "::add-mask::$password"
(umask 077 && printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$work/certificate.p12")

security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$work/certificate.p12" -k "$keychain" -f pkcs12 -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" > /dev/null
read -r -a others <<< "$(security list-keychains -d user | tr -d '"' | tr '\n' ' ')"
security list-keychains -d user -s "$keychain" "${others[@]}"
if ! security find-identity -v -p codesigning "$keychain" | grep -qF "\"$APPLE_SIGNING_IDENTITY\""; then
  echo "The keychain holds no valid signing identity named by APPLE_SIGNING_IDENTITY" >&2
  security find-identity -p codesigning "$keychain" >&2
  exit 1
fi
