#!/usr/bin/env sh
# Install Mnemo from this checkout: one `mnemo` binary and the `memsrv` memory
# sidecar into $MNEMO_HOME/bin (default ~/.mnemo/bin), linked onto PATH.
#
#   app/scripts/install.sh            build and install
#   app/scripts/install.sh --dry-run  say what would happen, do nothing
#
# Needs: bun (builds the binary), cargo (builds memsrv). python3 is optional —
# without it the ipy_run tool is simply not offered. Running it twice is safe.
set -eu

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_DIR=$(cd "$APP_DIR/.." && pwd)
HOME_DIR=${MNEMO_HOME:-"$HOME/.mnemo"}
BIN_DIR="$HOME_DIR/bin"
LINK_DIR=${MNEMO_LINK_DIR:-"$HOME/.local/bin"}

say() { printf '  %s\n' "$*"; }
run() {
  printf '  $ %s\n' "$*"
  [ "$DRY" -eq 1 ] || "$@"
}
need() {
  if command -v "$1" >/dev/null 2>&1; then say "✓ $1 $( "$1" --version 2>/dev/null | head -n1 )"; else say "✗ $1 — $2"; MISSING=1; fi
}

echo "mnemo installer"
MISSING=0
need bun "install it: curl -fsSL https://bun.sh/install | bash"
need cargo "install Rust: https://rustup.rs"
command -v python3 >/dev/null 2>&1 && say "✓ python3 (ipy_run enabled)" || say "· python3 not found — ipy_run will be off"
[ "$MISSING" -eq 0 ] || { echo "missing requirements above; nothing was changed"; exit 1; }

echo "building"
run sh -c "cd '$REPO_DIR/memory-layer' && cargo build --release --bin memsrv"
run sh -c "cd '$APP_DIR' && bun install --frozen-lockfile && bun scripts/build.ts"

echo "installing into $BIN_DIR"
run mkdir -p "$BIN_DIR" "$LINK_DIR"
run cp "$APP_DIR/dist/mnemo" "$BIN_DIR/mnemo"
run cp "$REPO_DIR/memory-layer/target/release/memsrv" "$BIN_DIR/memsrv"
run ln -sf "$BIN_DIR/mnemo" "$LINK_DIR/mnemo"

case ":$PATH:" in
  *":$LINK_DIR:"*) ;;
  *) say "add $LINK_DIR to your PATH, e.g.  echo 'export PATH=\"$LINK_DIR:\$PATH\"' >> ~/.profile" ;;
esac

if [ "$DRY" -eq 0 ]; then
  echo "checking"
  "$BIN_DIR/mnemo" doctor || true
  echo "done — run: mnemo   (first time: /login to add a provider)"
fi
