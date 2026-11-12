#!/bin/sh
# Installs the exangelos binary and its alias xng.
#
#   EXANGELOS_RELEASE      where the release files are: an https:// or file:// URL, or a
#                          local directory. Required until a release is published.
#   EXANGELOS_VERSION      version to install. Defaults to the only one in SHA256SUMS.
#   EXANGELOS_INSTALL_DIR  defaults to $HOME/.local/bin.
#
# The script changes nothing outside the install directory. The daemon installs its
# own user service on first use.
set -eu

fail() {
  echo "exangelos install: $*" >&2
  exit 1
}

release="${EXANGELOS_RELEASE:-}"
[ -n "$release" ] || fail "set EXANGELOS_RELEASE to the release URL or directory"
install_dir="${EXANGELOS_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported system $(uname -s)" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported machine $(uname -m)" ;;
esac
if [ "$os" = linux ] && ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
  fail "the Linux build needs glibc; this system has another C library"
fi

fetch() {
  case "$release" in
    file://*) cp "${release#file://}/$1" "$2" ;;
    *://*) curl -fsSL "$release/$1" -o "$2" ;;
    *) cp "$release/$1" "$2" ;;
  esac || fail "cannot fetch $1 from $release"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

fetch SHA256SUMS "$work/SHA256SUMS"
if [ -n "${EXANGELOS_VERSION:-}" ]; then
  archive="exangelos-$EXANGELOS_VERSION-$os-$arch.tar.gz"
else
  matches="$(sed -n "s/^[0-9a-f]\{64\} [ *]\(exangelos-.*-$os-$arch\.tar\.gz\)\$/\1/p" "$work/SHA256SUMS")"
  [ -n "$matches" ] || fail "no exangelos archive for $os-$arch in SHA256SUMS"
  [ "$(printf '%s\n' "$matches" | wc -l | tr -d ' ')" = 1 ] || fail "several versions in SHA256SUMS, set EXANGELOS_VERSION"
  archive="$matches"
fi
expected="$(awk -v file="$archive" '$2 == file || $2 == "*" file { print $1 }' "$work/SHA256SUMS")"
[ -n "$expected" ] || fail "SHA256SUMS has no line for $archive"

fetch "$archive" "$work/$archive"
actual="$(sha256 "$work/$archive")"
[ "$actual" = "$expected" ] || fail "checksum mismatch for $archive: expected $expected, got $actual"

mkdir "$work/unpacked"
tar -xzf "$work/$archive" -C "$work/unpacked"
[ -f "$work/unpacked/exangelos" ] || fail "$archive holds no exangelos binary"

mkdir -p "$install_dir"
cp "$work/unpacked/exangelos" "$install_dir/exangelos.new"
chmod 755 "$install_dir/exangelos.new"
mv -f "$install_dir/exangelos.new" "$install_dir/exangelos"
ln -sf exangelos "$install_dir/xng"

echo "Installed $install_dir/exangelos and $install_dir/xng"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to your PATH to run exangelos." ;;
esac
