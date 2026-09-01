# Audit Summary — Security & Testing Deep Audit

*Run 3, 2026-08-31. Three parallel auditors (sec-backend, sec-surface, tests),
all read-only, all findings logged through `audit/record.py` (single writer,
flock + atomic replace; the hook's own race bug is logged, fixed, marked
`fixed`). Full log: `audit/FINDINGS.jsonl`. Queried via `audit/record.py
list|count|dump`.*

## Totals

- **53 findings**: 4 high · 22 medium · 22 low · 5 info (2 record.py bugs are
  `fixed`)
- By auditor: sec-backend 26 · sec-surface 16 · tests 11
- By category: sec 36 · ops 7 · test 6 · hygiene 3 · docs 1

## The one that matters: the approval gate is bypassable in two hops

Two findings that are individually high and combined critical-equivalent:

1. **`0384ee03`** — `ipy_run` is not in `GATED_TOOLS`: arbitrary Python
   executes with no prompt under default permissions. Verified in
   `approval-gate.ts`/`permissions.ts`.
2. **`b6afa93e`** — `spawn_subagent` children are non-TTY, so the approval
   gate fails open: delegated subagents run bash/write unprompted.

Together: a confused/mis-prompted agent can run anything without asking, and
it doesn't even need the interactive path — delegate. **This is the top
remediation item.** (Combined effect of `attach_approval` + ipy + subagent
bypasses the product's core permission promise.)

## Remediation queue (ordered; owner codebase in parens — agent / memory-layer /

harness-engine / tui-go / CI-repo)

### 1. Critical-equivalent (fix first)

- [ ] **Approval-gate chain** (`0384ee03` + `b6afa93e`): ipy_run into the
  gated set; subagent children approval-capable (or fail CLOSED non-TTY for
  mutating tools). (agent)
- [ ] **Harness gate is a gate only on the create path**: watcher/disk-loaded
  bundles bypass it entirely (`ccdbbb2b` + `51b81dda` merged); relative/abs
  imports always pass the blocklist (`747c8c3b`); computed/backtick
  specifiers (`56b733fa`, enumeration `f685ee0a`, 3-builtins-only `a0dfa43b`).
  One fix: gate on every load, import-analysis that can't be regex-bypassed.
  (harness-engine + agent)
- [ ] **Memsrv journal amnesia** (`ab99acb1`, would-elevate-to-high): one
  corrupt/partial journal line → memsrv reports 0 ops on startup, total
  memory loss. Empirical proof. Fix with the hook's own pattern: tolerant
  journal load + quarantine + atomic writes. Related: non-UTF8 kill
  (`e8e7d9e2`), lock-less `read_all` (`dbfee81a`), unbounded frame/journal
  growth (`f7c2c763`). (memory-layer)

### 2. Medium security (batch 2)

- [ ] web_fetch SSRF — localhost/private/metadata + redirects followed (`3927a1ac`). (agent)
- [ ] bash allow-rule glob matches whole command string — `ls*` approves `ls ; rm -rf /` (`3c265f44`). (agent)
- [ ] No path containment in file tools (absolute paths pass; no symlink canonicalization) (`e00cd116`). (agent)
- [ ] Stored API key injected into `process.env` inherited by every child (`68846059`). (agent)
- [ ] Trace redaction gaps (URL tokens, `sk-or-`/`tvly-` shapes, 120-char verbatim args) (`2fefd9ce`). (agent)
- [ ] CI secrets gate red on main (matches own fixture) + regex misses + history-blind (`5e28efcf`, `f5efc6ba`, `3f198bdf`); GITHUB_TOKEN perms (`144c276d`); npm ci vs install (`23e58063`); mutable action tags (`89697e08`). (CI-repo)
- [ ] Hook executor: `sh -c` with no default timeout / no scope confinement (`41ab8d40`); block-reason persisted to trace logs (`fa244d3f`). (agent)
- [ ] auth.json write follows pre-planted symlinks (`dd3118fb`). (agent)
- [ ] Search cache not invalidated after Unlink/Reweight/RecordOutcome (`cddd21c0`). (memory-layer)
- [ ] Go memory client: timeout leaks reader goroutine that eats later replies (`4745e2a2`); `os.Exit` orphans agent child (`7bbead71`). (tui-go)

### 3. Testing gaps (batch 3)

- [ ] `internal/agent` 0% coverage — owns the spawn/stream/interrupt contract (`572d7d4d`). (tui-go)
- [ ] `internal/pi` tested against hand-rolled JSON literals; upstream caret-pinned `^0.84.3` — contract-drift risk (`af582760`). (tui-go)
- [ ] `internal/markdown` 0%, `internal/prompt` 25%, `bin/mnemo.ts` no tests, `--test-force-exit` masks handle leaks (`0ada275f`, `edfe2f6a`, `b7b6c912`, `01c4ef84`). (tui-go + agent)

### 4. Low / hygiene / docs

- MCP orphan on SIGTERM-resistant servers (`1c31b0fe`); kernel resource limits (`e4cc567c`); blocking embed retries stall RPC loop (`6f96adc6`); scope shadowing (`b02291c2`); manifest refs escape bundle dir (`dcd8c081`); watcher symlink containment (`593e9a39`); doc drift go 1.22 vs 1.27 (`2bf9a1a9`); CI no drift/freshness checks (`2f298097`).
- Design notes (confirm, not defects): in-process unsandboxed harness execution (`a739fbd8`), in-kernel `tools.*` skip prompting (`48236eda`), embeddings exfiltrate node text by design (`509e8ec5`), kernel pipe attrs reachable (`467cb8ad`).

## Working-tree note

`go test ./...` is red on the working tree only because AREA 10.5 (schedules
overlay) is in-flight and uncommitted from the schedules-agent outage
(`4b24b4b0`); committed HEAD is exactly green (329/347/74/19, all claims
verified true by the testing auditor).

## Ruled safe (verified, worth keeping)

Permission matcher semantics; deny enforced regardless of TTY; plan-mode
holds for ipy_run + in-kernel calls; `tools.parallel` gating; ipy bridge
frame-spoofing immunity; operator-controlled subagent binary; MCP
framing/timeouts; web scheme gate; hooks matchers non-shell/fail-closed;
auth file 0600 + chmod; store weight clamps; consolidate idempotence;
remote URL hardcoded; cache key complete; tui-go session/filetree/memory
parsing; determinism hygiene (temp dirs, injected homes, no network in
tests); CI job order (memsrv before agent); harness-engine zero runtime deps.
