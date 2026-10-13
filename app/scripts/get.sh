#!/usr/bin/env sh
# Install Mnemo: the `mnemo` binary and its `memsrv` memory sidecar for this
# machine, into $MNEMO_HOME/bin (default ~/.mnemo/bin), linked onto PATH. Nothing
# else is needed: no Bun, Node, Rust or Python.
#
#   curl -fsSL https://github.com/AtmanMishra/Mnemo/releases/latest/download/install.sh | sh
#
# Options (after `sh -s --` when piped):
#   --version <tag>   install that release (v0.1.0) instead of the latest
#   --uninstall       remove the binaries and the link (memory and sessions stay)
#   --deep            with --uninstall (or alone): also delete $MNEMO_HOME — memory,
#                     sessions, credentials, skills, logs, settings. Asks first.
#   --yes             do not ask (for scripts)
#   --help
#
# Environment:
#   MNEMO_VERSION        same as --version
#   MNEMO_HOME           where Mnemo lives (default ~/.mnemo)
#   MNEMO_LINK_DIR       where the `mnemo` link goes (default ~/.local/bin)
#   MNEMO_RELEASE_BASE   where the archives are (a mirror, or file:///dir for a local test)
#   MNEMO_REPO           owner/name of the GitHub repository (default AtmanMishra/Mnemo)
#   MNEMO_UNINSTALL=1    same as --uninstall; MNEMO_UNINSTALL=deep same as --deep
#   NO_COLOR=1           plain output, no animation (also when not on a terminal)
#
# Running it again upgrades in place. Your memory, sessions and settings in
# $MNEMO_HOME are never touched. The archive's SHA-256 is checked against the
# release's SHA256SUMS before anything is installed.
#
# Everything is inside main() and main runs on the last line, so a download that
# is cut off halfway runs nothing.
set -eu

main() {
  REPO=${MNEMO_REPO:-AtmanMishra/Mnemo}
  HOME_DIR=${MNEMO_HOME:-"$HOME/.mnemo"}
  BIN_DIR="$HOME_DIR/bin"
  LINK_DIR=${MNEMO_LINK_DIR:-"$HOME/.local/bin"}
  VERSION=${MNEMO_VERSION:-}
  UNINSTALL=
  DEEP=
  YES=
  case "${MNEMO_UNINSTALL:-}" in "" | 0 | false | no) ;; deep) UNINSTALL=1; DEEP=1 ;; *) UNINSTALL=1 ;; esac

  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || fail "--version needs a tag, e.g. v0.1.0"; VERSION=$2; shift ;;
      --uninstall) UNINSTALL=1 ;;
      --deep) UNINSTALL=1; DEEP=1 ;;
      --yes | -y) YES=1 ;;
      -h | --help) sed -n '2,28p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; return 0 ;;
      *) fail "unknown option $1 (--help lists them)" ;;
    esac
    shift
  done

  # These end up in a URL and a download: refuse anything that is not what it says.
  case "$REPO" in .* | */.* | */ | /* | */*/* | *[!A-Za-z0-9._/-]* | "") fail "MNEMO_REPO must look like owner/name, not $REPO" ;; */*) ;; *) fail "MNEMO_REPO must look like owner/name, not $REPO" ;; esac
  case "$VERSION" in "") ;; v[0-9]*) case "$VERSION" in *[!A-Za-z0-9.+-]*) fail "version must look like v0.1.0, not $VERSION" ;; esac ;; *) fail "version must look like v0.1.0, not $VERSION" ;; esac

  if [ -n "$UNINSTALL" ]; then
    banner "uninstall"
    if [ -n "$DEEP" ]; then
      mnemo_home "$HOME_DIR" || fail "$HOME_DIR does not look like Mnemo's folder (it holds other files); not deleting it. Remove what you want by hand."
      say "this deletes $HOME_DIR: memory, sessions, credentials, skills, logs and settings"
      if [ -z "$YES" ]; then
        ( : < /dev/tty ) 2>/dev/null || fail "not a terminal: add --yes to delete $HOME_DIR"
        printf '  type "delete" to go ahead: ' > /dev/tty
        read -r answer < /dev/tty || answer=
        [ "$answer" = delete ] || { say "nothing changed"; return 1; }
      fi
    fi
    step "removing mnemo and memsrv" remove_binaries
    if [ -n "$DEEP" ]; then
      step "deleting $HOME_DIR" rm -rf "$HOME_DIR"
      done_line "Mnemo and everything it kept are gone"
    else
      done_line "removed mnemo and memsrv"
      say "your memory, sessions and settings are still in $HOME_DIR (--deep deletes them too)"
    fi
    say "if you attached memory to Claude Code or Codex (mnemo memory setup), remove the mnemo entries from their settings"
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
    case "$base" in
      https://* | file://*) ;;
      *) fail "MNEMO_RELEASE_BASE must start with https:// or file://" ;;
    esac
    say "! downloading from $base instead of github.com/$REPO: only continue if you chose that"
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

  banner "installer · $platform"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  WATCH="$tmp/$archive"
  step "downloading $archive" fetch "$base/$archive" "$tmp/$archive" || fail "could not download $base/$archive"
  WATCH=
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download the checksums"
  want=$(grep " \*\{0,1\}$archive\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
  [ -n "$want" ] || fail "$archive is not in SHA256SUMS"
  got=$(sha256 "$tmp/$archive")
  [ "$want" = "$got" ] || fail "checksum mismatch for $archive (expected $want, got $got)"
  ok_line "checksum"

  mkdir -p "$BIN_DIR" "$LINK_DIR"
  # Memory, sessions and credentials will live here: yours alone.
  chmod 700 "$HOME_DIR"
  # Take the two files we expect and nothing else the archive might carry.
  tar -xzf "$tmp/$archive" -C "$tmp" mnemo memsrv 2>/dev/null || fail "$archive does not hold mnemo and memsrv"
  for f in mnemo memsrv; do
    [ -f "$tmp/$f" ] && [ ! -L "$tmp/$f" ] || fail "$archive has no regular file $f"
    chmod +x "$tmp/$f"
  done
  # Copy beside the target, then rename: a rename is atomic, so an interrupt leaves
  # the old file whole, and a running mnemo is replaced rather than written into.
  for f in mnemo memsrv; do
    cp "$tmp/$f" "$BIN_DIR/.$f.new.$$" && mv -f "$BIN_DIR/.$f.new.$$" "$BIN_DIR/$f"
  done
  if [ -e "$LINK_DIR/mnemo" ] || [ -L "$LINK_DIR/mnemo" ]; then
    if [ -L "$LINK_DIR/mnemo" ] && [ "$(readlink "$LINK_DIR/mnemo")" = "$BIN_DIR/mnemo" ]; then :
    else say "! $LINK_DIR/mnemo already exists and is not ours; left alone. Run $BIN_DIR/mnemo or fix your PATH"; linked=no; fi
  fi
  [ "${linked:-}" = no ] || ln -sf "$BIN_DIR/mnemo" "$LINK_DIR/mnemo"
  ok_line "installed into $BIN_DIR"

  case ":$PATH:" in
    *":$LINK_DIR:"*) ;;
    *) say "add $LINK_DIR to your PATH:  echo 'export PATH=\"$LINK_DIR:\$PATH\"' >> ~/.profile" ;;
  esac

  echo "checking"
  "$BIN_DIR/mnemo" doctor || true
  command -v python3 >/dev/null 2>&1 || say "python3 not found: the ipy_run tool stays off until it is installed"
  finale
  echo "done: run  mnemo   (first time: the introduction walks you through a model)"
  echo "      update:     mnemo update"
  echo "      uninstall:  mnemo uninstall   (--deep also deletes memory, sessions and settings)"
}

remove_binaries() {
  rm -f "$BIN_DIR/mnemo" "$BIN_DIR/memsrv"
  # Remove the link only if it is ours.
  if [ -L "$LINK_DIR/mnemo" ] && [ "$(readlink "$LINK_DIR/mnemo")" = "$BIN_DIR/mnemo" ]; then rm -f "$LINK_DIR/mnemo"; fi
  rmdir "$BIN_DIR" 2>/dev/null || true
}

# A folder is deleted whole only if it is plainly Mnemo's: not / or your home,
# and holding nothing but what Mnemo puts there (the list matches HOME_ENTRIES in src/runtime/uninstall.ts).
mnemo_home() {
  [ -d "$1" ] || return 1
  case "$(cd "$1" && pwd -P)" in / | "$(cd "$HOME" && pwd -P)") return 1 ;; esac
  found=
  for e in "$1"/* "$1"/.[!.]*; do
    [ -e "$e" ] || continue
    case "${e##*/}" in
      state.json* | agent | memory | bin | logs | kernel | best-of | permissions.json | grants.json | skill-history | journal.jsonl) found=1 ;;
      .*) ;;
      *) return 1 ;;
    esac
  done
  [ -n "$found" ]
}

# ── The look. On a terminal: colour and motion. Otherwise (a pipe, CI, NO_COLOR): plain lines.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then FANCY=1; else FANCY=; fi
c() { [ -n "$FANCY" ] && printf '\033[38;2;%sm' "$1"; }
r() { [ -n "$FANCY" ] && printf '\033[0m'; }
MAG="255;92;138"; CYA="61;219;217"; AMB="255;181;71"; DIM="138;127;148"; GRN="123;224;123"; VIO="157;123;255"
nap() { [ -n "$FANCY" ] && sleep "$1" 2>/dev/null || true; }

banner() {
  if [ -z "$FANCY" ]; then echo "mnemo $1"; return; fi
  printf '\n'
  # The wordmark, written in one row at a time, magenta to cyan.
  for row in \
    "█▀▄▀█ █▄ █ █▀▀ █▀▄▀█ █▀█" \
    "█ ▀ █ █ ▀█ ██▄ █ ▀ █ █▄█"; do
    printf '  %s%s%s\n' "$(c "$MAG")" "$row" "$(r)"
    nap 0.06
  done
  printf '  %s◆───◆───◆%s %s%s%s\n\n' "$(c "$CYA")" "$(r)" "$(c "$DIM")" "$1" "$(r)"
}

ok_line() { if [ -n "$FANCY" ]; then printf '  %s✓%s %s\n' "$(c "$GRN")" "$(r)" "$*"; else say "✓ $*"; fi; }
done_line() { if [ -n "$FANCY" ]; then printf '\n  %s◆%s %s\n' "$(c "$MAG")" "$(r)" "$*"; else say "$*"; fi; }

# step "what" command args…: on a terminal, a dither pulse runs while it works
# (with the bytes so far when $WATCH names a file being downloaded), then ✓ or ✗.
step() {
  label=$1; shift
  if [ -z "$FANCY" ]; then say "$label"; "$@"; return; fi
  "$@" &
  pid=$!
  n=0
  while kill -0 "$pid" 2>/dev/null; do
    case $((n % 6)) in 0) f="░" ;; 1) f="▒" ;; 2) f="▓" ;; 3) f="█" ;; 4) f="▓" ;; *) f="▒" ;; esac
    extra=
    if [ -n "${WATCH:-}" ] && [ -f "$WATCH" ]; then extra=" $(( $(wc -c < "$WATCH") / 1024 )) KB"; fi
    printf '\r  %s%s%s %s%s%s%s\033[K' "$(c "$MAG")" "$f" "$(r)" "$label" "$(c "$DIM")" "$extra" "$(r)"
    n=$((n + 1))
    sleep 0.08 2>/dev/null || sleep 1
  done
  if wait "$pid"; then printf '\r  %s✓%s %s\033[K\n' "$(c "$GRN")" "$(r)" "$label"; return 0
  else printf '\r  %s✗%s %s\033[K\n' "$(c "$MAG")" "$(r)" "$label"; return 1; fi
}

# The last frame: Mne, in pixels, and the memory wire drawing itself.
finale() {
  [ -n "$FANCY" ] || return 0
  printf '\n'
  for row in "  ▄▀▀▀▀▀▀▄" "▄▀▀████▀▀▄" "█▀██▀▀██▀█" " ▀▀████▀▀" "   ████"; do
    printf '    %s%s%s\n' "$(c "$VIO")" "$row" "$(r)"; nap 0.05
  done
  printf '    '
  for node in 1 2 3 4 5; do printf '%s◆%s' "$(c "$AMB")" "$(r)"; [ "$node" = 5 ] || { printf '%s───%s' "$(c "$CYA")" "$(r)"; }; nap 0.07; done
  printf '  %sMne remembers.%s\n\n' "$(c "$DIM")" "$(r)"
}

say() { printf '  %s\n' "$*"; }
fail() { printf 'mnemo install: %s\n' "$*" >&2; exit 1; }

fetch() {
  case "$1" in
    file://*) cp "${1#file://}" "$2" ;;
    *)
      if command -v curl >/dev/null 2>&1; then curl --proto '=https' --tlsv1.2 -fsSL "$1" -o "$2"
      elif command -v wget >/dev/null 2>&1; then wget --https-only -qO "$2" "$1"
      else fail "needs curl or wget"; fi ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

main "$@"
