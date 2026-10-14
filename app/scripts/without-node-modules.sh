#!/usr/bin/env sh
# Runs a command with the workspace's node_modules (the repository's and app's) moved out
# of the way, and puts them back afterwards whatever happens, keeping the command's exit
# code. The end-to-end suite runs the compiled binary this way, so anything the binary
# still reads from the build tree fails in CI instead of on a user's machine.
#
#   sh app/scripts/without-node-modules.sh bun test --timeout 120000 ./e2e
#
# The folders are renamed, not copied, into a sibling of $RUNNER_TEMP (or $TMPDIR): on a
# CI runner that is the same volume, so it is instant on Linux, macOS and Windows alike.
set -eu
ROOT=${MNEMO_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
hidden=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hidden-node_modules.XXXXXX")
restore() {
  [ ! -d "$hidden/root" ] || mv "$hidden/root" "$ROOT/node_modules"
  [ ! -d "$hidden/app" ] || mv "$hidden/app" "$ROOT/app/node_modules"
  rmdir "$hidden" 2>/dev/null || true
}
trap restore EXIT
trap 'exit 130' INT TERM
[ ! -d "$ROOT/node_modules" ] || mv "$ROOT/node_modules" "$hidden/root"
[ ! -d "$ROOT/app/node_modules" ] || mv "$ROOT/app/node_modules" "$hidden/app"
"$@"
