#!/bin/sh
# Start Mnemo with everything wired: the live agent, the memory sidecar, and
# the tool bundles. Run it from anywhere; paths are resolved from this file,
# and the working directory you launch in is the one the agent works in.
set -e
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(dirname "$here")

exec "$here/mnemo" \
  --repo    "$repo" \
  --memsrv  "$repo/memory-layer/target/debug/memsrv" \
  --journal "$repo/memory-layer/data/sea-agent-journal.jsonl" \
  --bundles "$repo/harness-engine/bundles" \
  "$@"
