#!/usr/bin/env bash
# Mnemo pre-alpha installer — macOS and Linux.
#
#   Run it from a checkout of this repository:
#
#       ./scripts/install.sh              # checks, builds, installs
#       ./scripts/install.sh --dry-run    # say what it would do, change nothing
#
# What it does, in order: checks your toolchain, installs the agent runtime's
# dependencies, builds the memory sidecar (if you have Rust) and the interface
# (if you have Go), then puts `mnemo` on your PATH.
#
# Nothing here is irreversible and nothing writes outside the repository,
# ~/.local/bin and the toolchain's own caches. `--dry-run` proves that.
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${MNEMO_BIN_DIR:-$HOME/.local/bin}"
NODE_FLOOR_MAJOR=22
NODE_FLOOR_MINOR=18

step() { printf '\n▸ %s\n' "$*"; }
say()  { printf '    %s\n' "$*"; }
ok()   { printf '    ✓ %s\n' "$*"; }
warn() { printf '    ! %s\n' "$*"; }
die()  { printf '\n✗ %s\n\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '    would run: %s\n' "$*"
  else
    ( cd "$1" && shift && "$@" )
  fi
}

printf '\nMnemo pre-alpha installer\n'

# --- 1. is this actually a checkout -----------------------------------------
step "Checking the checkout"
for d in agent memory-layer tui-go; do
  [ -d "$ROOT/$d" ] || die "$ROOT does not look like the Mnemo repository (no $d/).
    Clone it first:  git clone https://github.com/AtmanMishra/self-evolving-agent"
done
ok "found agent/, memory-layer/ and tui-go/"

# --- 2. the one hard requirement --------------------------------------------
# 22.18 is where Node runs .ts files with no flag; below it every file in
# agent/ dies on a type annotation, which reads as a Mnemo bug.
step "Checking Node (>= ${NODE_FLOOR_MAJOR}.${NODE_FLOOR_MINOR} required)"
command -v node >/dev/null 2>&1 || die "node is not on PATH.
    Install Node ${NODE_FLOOR_MAJOR}.${NODE_FLOOR_MINOR}+:
      macOS:  brew install node
      Linux:  https://nodejs.org/en/download  (or your package manager, if it is new enough)"
NODE_V="$(node -p 'process.versions.node')"
NODE_OK="$(node -p "const [m,n]=process.versions.node.split('.').map(Number); (m>${NODE_FLOOR_MAJOR} || (m===${NODE_FLOOR_MAJOR} && n>=${NODE_FLOOR_MINOR})) ? 1 : 0")"
if [ "$NODE_OK" != "1" ]; then
  die "Node $NODE_V is too old: Mnemo runs TypeScript directly, and that needs ${NODE_FLOOR_MAJOR}.${NODE_FLOOR_MINOR}+.
      nvm install ${NODE_FLOOR_MAJOR}.${NODE_FLOOR_MINOR} && nvm use ${NODE_FLOOR_MAJOR}.${NODE_FLOOR_MINOR}"
fi
ok "node $NODE_V"

# --- 3. the agent runtime ---------------------------------------------------
step "Installing the agent runtime (agent/)"
if [ "$DRY_RUN" = "1" ]; then
  run "$ROOT/agent" npm install
else
  ( cd "$ROOT/agent" && npm install --silent ) && ok "npm dependencies installed"
fi

# --- 4. the memory sidecar (optional) ---------------------------------------
step "Building the memory sidecar (memory-layer/) — optional"
if command -v cargo >/dev/null 2>&1; then
  run "$ROOT/memory-layer" cargo build --bin memsrv
  [ "$DRY_RUN" = "1" ] || ok "memsrv ready (skip it and the Memory pane stays offline; nothing else changes)"
else
  warn "cargo not found — memory will be offline."
  warn "To enable it: https://rustup.rs then re-run this script."
fi

# --- 5. the interface -------------------------------------------------------
step "Building the interface (tui-go/)"
if command -v go >/dev/null 2>&1; then
  run "$ROOT/tui-go" go build -o mnemo ./cmd/mnemo
  [ "$DRY_RUN" = "1" ] || ok "built tui-go/mnemo"
elif [ -x "$ROOT/tui-go/mnemo" ]; then
  ok "no Go toolchain, but tui-go/mnemo is already here (the release binary)"
else
  die "Neither Go nor a prebuilt binary.
    Build it:      install Go (https://go.dev/dl) and re-run
    Or download:   the mnemo-<tag>-<os>-<arch> binary for your platform from
                   https://github.com/AtmanMishra/self-evolving-agent/releases
                   and put it at tui-go/mnemo"
fi

# --- 6. put it on PATH ------------------------------------------------------
step "Installing to $BIN_DIR"
if [ "$DRY_RUN" = "0" ]; then
  mkdir -p "$BIN_DIR"
  cp "$ROOT/tui-go/mnemo" "$BIN_DIR/mnemo"
  chmod +x "$BIN_DIR/mnemo"
fi
ok "$BIN_DIR/mnemo"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Add it:"
     warn "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.profile && . ~/.profile" ;;
esac

# --- 7. what to do now ------------------------------------------------------
printf '\nDone.\n\n'
say "mnemo --version                      # the build you just installed"
say "mnemo --repo $ROOT                  # start it, pointed at this checkout"
printf '\n'
say "First run: /login walks you through picking a provider and pasting a key."
say "Bugs and rough edges: https://github.com/AtmanMishra/self-evolving-agent/issues"
printf '\n'
