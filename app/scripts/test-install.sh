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
  grep -q "retries" /tmp/demo.txt || { cat /tmp/demo.txt; echo "FAIL: a scripted turn ran"; exit 1; }; echo "✓ a scripted turn ran"
  grep -E "Learned|Session done|failed" /tmp/demo.txt || true
  echo "--- again (upgrade in place)"; sh /release/install.sh > /dev/null || { echo "FAIL: reinstall"; exit 1; }; echo "✓ reinstall"
  echo "--- memory written by the demo is kept by an uninstall"
  mkdir -p "$HOME/.mnemo/memory" && echo keep > "$HOME/.mnemo/memory/journal.jsonl"
  sh /release/install.sh --uninstall > /dev/null
  [ ! -e "$HOME/.mnemo/bin/mnemo" ] && [ ! -e "$HOME/.mnemo/bin/memsrv" ] && [ ! -e "$HOME/.local/bin/mnemo" ] || { echo "FAIL: binaries and link removed"; exit 1; }; echo "✓ binaries and link removed"
  [ "$(cat "$HOME/.mnemo/memory/journal.jsonl")" = keep ] || { echo "FAIL: memory untouched"; exit 1; }; echo "✓ memory untouched"
  echo "--- an unrelated mnemo on the PATH is left alone"
  mkdir -p "$HOME/.local/bin" && echo mine > "$HOME/.local/bin/mnemo"
  sh /release/install.sh > /tmp/out 2>&1
  [ "$(cat "$HOME/.local/bin/mnemo")" = mine ] && grep -q "not ours" /tmp/out || { echo "FAIL: foreign file kept, and said so"; exit 1; }; echo "✓ foreign file kept, and said so"
  rm -f "$HOME/.local/bin/mnemo"; sh /release/install.sh --uninstall > /dev/null
  echo "--- overrides that would point the download somewhere else are refused"
  for bad in "MNEMO_REPO=../evil/x" "MNEMO_REPO=a/b/c" "MNEMO_VERSION=../../evil/x/releases/download/v1" "MNEMO_RELEASE_BASE=http://example.com/r"; do
    if env "$bad" sh /release/install.sh >/dev/null 2>/tmp/err; then echo "accepted $bad"; exit 1; fi
    [ -s /tmp/err ] || { echo "no reason given for $bad"; exit 1; }
  done
  echo "✓ four bad overrides refused"
  MNEMO_UNINSTALL=0 sh /release/install.sh > /dev/null && [ -e "$HOME/.mnemo/bin/mnemo" ] || { echo "FAIL: MNEMO_UNINSTALL=0 installs"; exit 1; }; echo "✓ MNEMO_UNINSTALL=0 installs"
  sh /release/install.sh --uninstall > /dev/null
  echo "--- no curl or wget: say so before doing anything"
  if MNEMO_RELEASE_BASE= sh /release/install.sh --version v9.9.9 >/tmp/out 2>/tmp/err; then echo "unexpected success"; exit 1; fi
  grep -q "needs curl or wget" /tmp/err && ! grep -q downloading /tmp/out || { echo "FAIL: clear error, nothing started"; exit 1; }; echo "✓ clear error, nothing started"
  echo "--- a release that does not exist (curl answers 404) fails cleanly"
  printf "#!/bin/sh\nexit 22\n" > /usr/local/bin/curl && chmod +x /usr/local/bin/curl
  if MNEMO_RELEASE_BASE= sh /release/install.sh --version v9.9.9 >/dev/null 2>/tmp/err; then echo "unexpected success"; exit 1; fi
  grep -q "could not download" /tmp/err || { echo "FAIL: clear error"; exit 1; }; echo "✓ clear error"
  [ ! -e "$HOME/.mnemo/bin/mnemo" ] || { echo "FAIL: nothing installed"; exit 1; }; echo "✓ nothing installed"
  rm -f /usr/local/bin/curl
  echo "--- deep uninstall: the script, then the program itself"
  sh /release/install.sh > /dev/null && mkdir -p "$HOME/.mnemo/memory" && echo j > "$HOME/.mnemo/memory/journal.jsonl"
  if sh /release/install.sh --deep < /dev/null > /dev/null 2>&1; then echo "deleted without asking"; exit 1; fi
  [ -e "$HOME/.mnemo/memory/journal.jsonl" ] || { echo "FAIL: --deep without a terminal asks for --yes"; exit 1; }; echo "✓ --deep without a terminal asks for --yes"
  sh /release/install.sh --deep --yes > /dev/null && [ ! -e "$HOME/.mnemo" ] && [ ! -e "$HOME/.local/bin/mnemo" ] || { echo "FAIL: --deep --yes removed everything"; exit 1; }; echo "✓ --deep --yes removed everything"
  sh /release/install.sh > /dev/null && "$HOME/.mnemo/bin/mnemo" uninstall --deep --yes > /dev/null && [ ! -e "$HOME/.mnemo" ] && [ ! -e "$HOME/.local/bin/mnemo" ] || { echo "FAIL: mnemo uninstall --deep --yes removed everything"; exit 1; }; echo "✓ mnemo uninstall --deep --yes removed everything"
'
