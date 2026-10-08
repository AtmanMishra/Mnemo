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
'
