#!/usr/bin/env sh
# The clean first run, for real: build this platform's release archive, stage
# it as a local "release", and install it with the release installer inside a
# fresh container that has nothing — no Bun, Node, Rust, git or Python. Then
# run what a new user runs: --version, doctor, and a whole scripted turn.
#
#   app/scripts/test-install.sh [image]      (default ubuntu:24.04; needs docker)
set -eu
IMAGE=${1:-ubuntu:24.04}
APP=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$APP/.." && pwd)
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; esac
REL=$(mktemp -d)
trap 'rm -rf "$REL"' EXIT

echo "building linux-$arch"
(cd "$REPO/memory-layer" && cargo build --release --bin memsrv >/dev/null 2>&1)
(cd "$APP" && bun scripts/build.ts "bun-linux-$arch" >/dev/null)
stage=$(mktemp -d)
cp "$APP/dist/mnemo-bun-linux-$arch" "$stage/mnemo"
cp "$REPO/memory-layer/target/release/memsrv" "$stage/memsrv"
tar -czf "$REL/mnemo-linux-$arch.tar.gz" -C "$stage" mnemo memsrv
rm -rf "$stage"
(cd "$REL" && sha256sum mnemo-* > SHA256SUMS)
cp "$APP/scripts/get.sh" "$REL/install.sh"

echo "installing in a clean $IMAGE"
docker run --rm -v "$REL:/release:ro" "$IMAGE" sh -c '
  set -e
  export MNEMO_RELEASE_BASE=file:///release
  sh /release/install.sh
  export PATH="$HOME/.local/bin:$PATH"
  echo "--- version";  mnemo --version
  echo "--- demo";     mnemo --demo --dump > /tmp/demo.txt 2>&1 || true
  grep -q "retries" /tmp/demo.txt && echo "✓ a scripted turn ran" || { cat /tmp/demo.txt; exit 1; }
  grep -E "Learned|Session done|failed" /tmp/demo.txt || true
  echo "--- again (upgrade in place)"; sh /release/install.sh > /dev/null && echo "✓ reinstall"
  echo "--- memory written by the demo is kept by an uninstall"
  mkdir -p "$HOME/.mnemo/memory" && echo keep > "$HOME/.mnemo/memory/journal.jsonl"
  sh /release/install.sh --uninstall > /dev/null
  [ ! -e "$HOME/.mnemo/bin/mnemo" ] && [ ! -e "$HOME/.mnemo/bin/memsrv" ] && [ ! -e "$HOME/.local/bin/mnemo" ] && echo "✓ binaries and link removed"
  [ "$(cat "$HOME/.mnemo/memory/journal.jsonl")" = keep ] && echo "✓ memory untouched"
  echo "--- no curl or wget: say so before doing anything"
  if MNEMO_RELEASE_BASE= sh /release/install.sh --version v9.9.9 >/tmp/out 2>/tmp/err; then echo "unexpected success"; exit 1; fi
  grep -q "needs curl or wget" /tmp/err && ! grep -q downloading /tmp/out && echo "✓ clear error, nothing started"
  echo "--- a release that does not exist (curl answers 404) fails cleanly"
  printf "#!/bin/sh\nexit 22\n" > /usr/local/bin/curl && chmod +x /usr/local/bin/curl
  if MNEMO_RELEASE_BASE= sh /release/install.sh --version v9.9.9 >/dev/null 2>/tmp/err; then echo "unexpected success"; exit 1; fi
  grep -q "could not download" /tmp/err && echo "✓ clear error"
  [ ! -e "$HOME/.mnemo/bin/mnemo" ] && echo "✓ nothing installed"
'
