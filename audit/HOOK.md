# Audit Hook — how the audit workflow logs findings

*The audit of the Mnemo monorepo runs through one hook: `audit/record.py`.
Every finding from every auditor goes through it. Nothing writes
`audit/FINDINGS.jsonl` directly.*

## Why a hook

An audit is only as good as its log. Without a common writer you get four
agents each keeping their own notes in their own formats, and the discovery
never consolidates. The hook gives us:

- **one schema** — every finding has the same shape, so anything can be
  queried (jq, python, the hook's own `list`/`count`/`dump`)
- **one writer** — `record.py` holds an exclusive file lock (`fcntl.flock`)
  while appending, so concurrent agents can never interleave or lose a line
- **one vocabulary** — severities (critical/high/medium/low/info) and
  categories (sec/test/hygiene/docs/ops) are fixed, no free-text invention
- **no duplicate noise** — a repeated (title, evidence) pair is rejected
- **an audit trail of the audit** — id + timestamp per finding, status
  lifecycle (open → confirmed/fixed/wonfix)

This is the same idea as the Mnemo hooks engine (AREA 9): a declarative,
uniform, auditable interception point — here the "event" is a finding, the
"hook" is a command, and the "audit trail" is the log itself.

## The finding schema (one JSON line)

```json
{
  "id": "a920e1ab",            // 8-hex, assigned
  "ts": 1760000000000,         // ms epoch, assigned
  "status": "open",            // open | confirmed | fixed | wonfix
  "severity": "high",          // critical | high | medium | low | info
  "category": "sec",           // sec | test | hygiene | docs | ops
  "agent": "sec-backend",      // which auditor logged it
  "target": "memory-layer",    // codebase / file / subsystem
  "title": "short, searchable", // required
  "evidence": "file.rs:120",   // where it was seen (file:line or command)
  "impact": "what an attacker/broken test/hybrid would actually do",
  "recommendation": "the smallest fix that closes it"
}
```

Required: severity, category, agent, target, title, impact.

## Usage

```bash
# log a finding (the ONLY way to write)
./audit/record.py add --severity high --category sec --agent sec-backend \
  --target "memory-layer/memsrv" --title "memsrv search misses a ttl on LRU" \
  --evidence "src/bin/memsrv.rs:210" --impact "..." --recommendation "..."

# read it back
./audit/record.py list                              # all, one line each
./audit/record.py list --severity high --agent sec-backend
./audit/record.py count --severity critical
./audit/record.py dump                              # jsonl, full rows
./audit/record.py dump --format md                  # a readable report
```

## Rules for auditors (the hook contract)

1. **Never edit `FINDINGS.jsonl` directly** — or any file under `audit/`
   except through `record.py`. The hook is the single writer, by design.
2. **One finding per call.** Don't batch unrelated issues; each line is one
   defensible claim with one evidence pointer.
3. **Evidence is a pointer, not a paragraph.** file:line, or a command that
   reproduced it. A finding without evidence is a rumor.
4. **Severity discipline.** `critical` = exploitable/secret-loss/data-loss
   without mitigation. `high` = likely exploitable or breaks a hard
   guarantee. `medium` = real issue, lower likelihood or impact.
   `low` = hygiene/robustness. `info` = observation worth recording.
5. **Verify before logging.** If it's a scan result, run the scan in the
   reply and paste the line; if it's code, cite the exact range. A partial
   truth in an audit log is worse than no entry.
6. **The audit is read-only for code.** Auditors never fix, never commit
   source changes, never touch other agents' in-flight files. Findings only.
   Fixes are follow-up work after the orchestrator triages.

## Lifecycle

After the auditors finish, the orchestrator triages: reads the whole log,
merges duplicates by (title, evidence), confirms vs. revises severities, and
marks each finding `confirmed` / `was` `wonfix`, then produces
`audit/SUMMARY.md` (severity-ranked) and files any fix work into plan.md.
