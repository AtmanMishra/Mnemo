#!/usr/bin/env sh
# Install Mnemo: the `mnemo` binary and its `memsrv` memory sidecar for this
# machine, into $MNEMO_HOME/bin (default ~/.mnemo/bin), linked onto PATH. Nothing
# else is needed: no Bun, Node, Rust or Python.
#
#   curl -fsSL https://github.com/AtmanMishra/mnemo/releases/latest/download/install.sh | sh
#
# Options (after `sh -s --` when piped):
#   --version <tag>   install that release (v0.1.0) instead of the latest
#   --uninstall       remove the binaries and the link (memory and sessions stay)
#   --help
#
# Environment:
#   MNEMO_VERSION        same as --version
#   MNEMO_HOME           where Mnemo lives (default ~/.mnemo)
#   MNEMO_LINK_DIR       where the `mnemo` link goes (default ~/.local/bin)
#   MNEMO_RELEASE_BASE   where the archives are (a mirror, or file:///dir for a local test)
#   MNEMO_REPO           owner/name of the GitHub repository (default AtmanMishra/mnemo)
#   MNEMO_UNINSTALL=1    same as --uninstall
#
# Running it again upgrades in place. Your memory, sessions and settings in
# $MNEMO_HOME are never touched. The archive's SHA-256 is checked against the
# release's SHA256SUMS before anything is installed.
#
# Everything is inside main() and main runs on the last line, so a download that
# is cut off halfway runs nothing.
set -eu

main() {
  REPO=${MNEMO_REPO:-AtmanMishra/mnemo}
  HOME_DIR=${MNEMO_HOME:-"$HOME/.mnemo"}
  BIN_DIR="$HOME_DIR/bin"
  LINK_DIR=${MNEMO_LINK_DIR:-"$HOME/.local/bin"}
  VERSION=${MNEMO_VERSION:-}
  UNINSTALL=${MNEMO_UNINSTALL:-}

  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || fail "--version needs a tag, e.g. v0.1.0"; VERSION=$2; shift ;;
      --uninstall) UNINSTALL=1 ;;
      -h | --help) sed -n '2,24p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; return 0 ;;
      *) fail "unknown option $1 (--help lists them)" ;;
    esac
    shift
  done

  if [ -n "$UNINSTALL" ]; then
    rm -f "$BIN_DIR/mnemo" "$BIN_DIR/memsrv"
    # Remove the link only if it is ours.
    if [ -L "$LINK_DIR/mnemo" ] && [ "$(readlink "$LINK_DIR/mnemo")" = "$BIN_DIR/mnemo" ]; then rm -f "$LINK_DIR/mnemo"; fi
    rmdir "$BIN_DIR" 2>/dev/null || true
    say "removed mnemo and memsrv"
    say "your memory, sessions and settings are still in $HOME_DIR (delete it to remove them too)"
    return 0
  fi

  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "unsupported system $(uname -s): on Windows use install.ps1" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported CPU $(uname -m)" ;;
  esac
  platform="$os-$arch"

  if [ -n "${MNEMO_RELEASE_BASE:-}" ]; then
    base="$MNEMO_RELEASE_BASE"
  elif [ -n "$VERSION" ]; then
    base="https://github.com/$REPO/releases/download/$VERSION"
  else
    base="https://github.com/$REPO/releases/latest/download"
  fi
  archive="mnemo-$platform.tar.gz"

  case "$base" in
    file://*) ;;
    *) command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || fail "needs curl or wget (apt install curl)" ;;
  esac

  echo "mnemo installer · $platform"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  say "downloading $archive"
  fetch "$base/$archive" "$tmp/$archive" || fail "could not download $base/$archive"
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download the checksums"
  want=$(grep " \*\{0,1\}$archive\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
  [ -n "$want" ] || fail "$archive is not in SHA256SUMS"
  got=$(sha256 "$tmp/$archive")
  [ "$want" = "$got" ] || fail "checksum mismatch for $archive (expected $want, got $got)"
  say "✓ checksum"

  mkdir -p "$BIN_DIR" "$LINK_DIR"
  tar -xzf "$tmp/$archive" -C "$tmp"
  for f in mnemo memsrv; do
    [ -f "$tmp/$f" ] || fail "$archive has no $f"
    # Move over the old file rather than into it, so a running mnemo is not corrupted.
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
  command -v python3 >/dev/null 2>&1 || say "python3 not found: the ipy_run tool stays off until it is installed"
  echo "done: run  mnemo   (first time: the introduction walks you through a model)"
  echo "      uninstall:  curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | sh -s -- --uninstall"
}

say() { printf '  %s\n' "$*"; }
fail() { printf 'mnemo install: %s\n' "$*" >&2; exit 1; }

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

main "$@"
