## What and why

<!-- One change, one reason. The diff says what; say why. -->

## How it was checked

<!-- Tests added or run; for agent behaviour, the eval or the numbers. -->

- [ ] `cd app && bunx tsc --noEmit && bun test ./test`
- [ ] `cd packages/memory && bunx tsc --noEmit && bun test ./test`
- [ ] `cargo test` in `memory-layer/` if the sidecar changed
- [ ] `DESIGN.md` updated if the interface vocabulary changed
- [ ] No keys, tokens or private paths in the diff
