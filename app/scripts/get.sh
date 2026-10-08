#!/usr/bin/env sh
# Install Mnemo from a GitHub release: the `mnemo` binary and the `memsrv`
# memory sidecar for this machine, into $MNEMO_HOME/bin (default ~/.mnemo/bin),
# linked onto PATH. Nothing else is needed — no Bun, Node or Rust.
#
#   curl -fsSL https://github.com/AtmanMishra/self-evolving-agent/releases/latest/download/install.sh | sh
#
# Environment:
#   MNEMO_VERSION        a tag (v0.1.0) instead of the latest release
#   MNEMO_HOME           where Mnemo lives (default ~/.mnemo)
#   MNEMO_LINK_DIR       where the `mnemo` link goes (default ~/.local/bin)
#   MNEMO_RELEASE_BASE   where the archives are (a mirror, or file:///dir for a local test)
#
# Running it again upgrades in place. Your memory, sessions and settings in
# $MNEMO_HOME are never touched.
set -eu

REPO="AtmanMishra/self-evolving-agent"
HOME_DIR=${MNEMO_HOME:-"$HOME/.mnemo"}
BIN_DIR="$HOME_DIR/bin"
LINK_DIR=${MNEMO_LINK_DIR:-"$HOME/.local/bin"}

say() { printf '  %s\n' "$*"; }
fail() { printf 'mnemo install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system $(uname -s) — on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac
platform="$os-$arch"

if [ -n "${MNEMO_RELEASE_BASE:-}" ]; then
  base="$MNEMO_RELEASE_BASE"
elif [ -n "${MNEMO_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/$MNEMO_VERSION"
else
  base="https://github.com/$REPO/releases/latest/download"
fi
archive="mnemo-$platform.tar.gz"

fetch() {
  case "$1" in
    file://*) cp "${1#file://}" "$2" ;;
    *)
      if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
      elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
      else fail "needs curl or wget"; fi ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

echo "mnemo installer · $platform"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
say "downloading $archive"
fetch "$base/$archive" "$tmp/$archive" || fail "could not download $base/$archive"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download the checksums"
want=$(grep " $archive\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
[ -n "$want" ] || fail "$archive is not in SHA256SUMS"
got=$(sha256 "$tmp/$archive")
[ "$want" = "$got" ] || fail "checksum mismatch for $archive (expected $want, got $got)"
say "✓ checksum"

mkdir -p "$BIN_DIR" "$LINK_DIR"
tar -xzf "$tmp/$archive" -C "$tmp"
for f in mnemo memsrv; do
  [ -f "$tmp/$f" ] || fail "$archive has no $f"
  mv -f "$tmp/$f" "$BIN_DIR/$f"
  chmod +x "$BIN_DIR/$f"
done
ln -sf "$BIN_DIR/mnemo" "$LINK_DIR/mnemo"
say "✓ installed into $BIN_DIR"

case ":$PATH:" in
  *":$LINK_DIR:"*) ;;
  *) say "add $LINK_DIR to your PATH:  echo 'export PATH=\"$LINK_DIR:\$PATH\"' >> ~/.profile" ;;
esac

echo "checking"
"$BIN_DIR/mnemo" doctor || true
command -v python3 >/dev/null 2>&1 || say "python3 not found — the ipy_run tool stays off until it is installed"
echo "done — run: mnemo   (first time: the introduction walks you through a model)"
