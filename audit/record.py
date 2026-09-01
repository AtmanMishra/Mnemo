#!/usr/bin/env python3
"""audit record.py — the findings hook. THE only writer of audit/FINDINGS.jsonl.

Usage:
  audit/record.py add --severity high --category sec --agent sec-backend \
      --target "memory-layer" --title "..." --evidence "memsrv.rs:120" \
      --impact "..." --recommendation "..."
  audit/record.py list [--severity X] [--category Y] [--agent A] [--target T]
  audit/record.py count [--severity X]
  audit/record.py dump [--format jsonl|md]
  audit/record.py repair

Concurrency contract (this is the point of the file): every write path holds
an exclusive flock on FINDINGS.lock across the WHOLE read-modify-write, and
save() writes to a temp file + os.replace() (atomic swap). Therefore two
concurrent adds can never interleave or truncate each other. load() never
dies on a bad line: it quarantines unparseable fragments to FINDINGS.corrupt
and returns the valid rows, so a single damaged line can never poison-pill
the log the way it did once (a truncated line from an unlocked rewrite froze
every add until a manual repair).

Every finding is a JSON line: {id, ts, status, severity, category, agent,
target, title, evidence, impact, recommendation}. Status starts "open";
orchestrator flips to confirmed/fixed/wonfix in the summary pass.
"""
import json
import fcntl
import os
import sys
import time
import uuid
from pathlib import Path
from typing import NoReturn

AUDIT_DIR = Path(__file__).resolve().parent
FINDINGS = AUDIT_DIR / "FINDINGS.jsonl"
LOCK = AUDIT_DIR / "FINDINGS.lock"
CORRUPT = AUDIT_DIR / "FINDINGS.corrupt"

SEVERITIES = {"critical", "high", "medium", "low", "info"}
CATEGORIES = {"sec", "test", "hygiene", "docs", "ops"}

REQUIRED = ["severity", "category", "agent", "target", "title", "impact"]


def die(msg: str, code: int = 2) -> NoReturn:
    sys.stderr.write(f"audit/record.py: {msg}\n")
    sys.exit(code)


def now_ms() -> int:
    try:
        return int(time.time() * 1000)
    except (OSError, ValueError) as e:
        die(f"clock read failed: {e}")


def parse_args(argv: list[str]) -> dict:
    out = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            if "=" in a:
                k, v = a[2:].split("=", 1)
                out[k.replace("-", "_")] = v
            else:
                if i + 1 >= len(argv):
                    die(f"flag {a} needs a value")
                out[a[2:].replace("-", "_")] = argv[i + 1]
                i += 1
        else:
            out.setdefault("_positional", []).append(a)
        i += 1
    return out


def _quarantine(bad: str, reason: str) -> None:
    """Append a damaged line to the corrupt log (never die on it)."""
    try:
        with open(CORRUPT, "a") as f:
            f.write(f"# {reason}\n{bad}\n")
    except OSError:
        pass  # quarantining must never be load-bearing


def load() -> list[dict]:
    """Valid rows only; damaged lines are quarantined, not fatal."""
    if not FINDINGS.exists():
        return []
    rows: list[dict] = []
    try:
        with open(FINDINGS) as f:
            for ln, line in enumerate(f, 1):
                s = line.strip()
                if not s:
                    continue
                try:
                    rows.append(json.loads(s))
                except json.JSONDecodeError:
                    _quarantine(s, f"unparseable line {ln}")
    except OSError as e:
        die(f"cannot read {FINDINGS}: {e}", 3)
    return rows


def save(rows: list[dict], lock_fd: int) -> None:
    """Atomic rewrite: temp file + os.replace, under the caller's flock."""
    tmp = FINDINGS.with_suffix(".tmp")
    try:
        with open(tmp, "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, FINDINGS)
    except OSError as e:
        try:
            tmp.unlink()
        except OSError:
            pass
        die(f"cannot write {FINDINGS}: {e}", 3)
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        except OSError:
            pass


def lock_findings():
    """Exclusive lock; callers must pass the fd to save() or release it."""
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        return fd
    except OSError as e:
        die(f"cannot lock {LOCK}: {e}", 3)


def add(args: dict) -> None:
    missing = [k for k in REQUIRED if not args.get(k)]
    if missing:
        die(f"missing required field(s): {', '.join(missing)}. See audit/HOOK.md.")
    sev = args["severity"].lower()
    cat = args["category"].lower()
    if sev not in SEVERITIES:
        die(f"severity must be one of {sorted(SEVERITIES)}")
    if cat not in CATEGORIES:
        die(f"category must be one of {sorted(CATEGORIES)}")

    fd = lock_findings()
    rows = load()
    seen = {(r.get("title", ""), r.get("evidence", "")) for r in rows}
    if (args["title"], args.get("evidence", "")) in seen:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        die("duplicate finding (same title+evidence already logged)", 1)

    row = {
        "id": str(uuid.uuid4())[:8],
        "ts": now_ms(),
        "status": "open",
        **{k: args.get(k) for k in REQUIRED},
        "evidence": args.get("evidence", ""),
        "recommendation": args.get("recommendation", ""),
    }
    rows.append(row)
    save(rows, fd)
    print(f"audit/record.py: logged {row['id']} [{sev} {cat}] {args['title'][:80]}")


def repair() -> None:
    """Quarantine damaged lines, rewrite the clean set. Idempotent."""
    fd = lock_findings()
    rows = load()
    save(rows, fd)
    corrupted = 0
    if CORRUPT.exists():
        try:
            with open(CORRUPT) as f:
                corrupted = sum(1 for l in f if l.strip() and not l.startswith("#"))
        except OSError:
            pass
    print(f"cleaned: {len(rows)} valid row(s); {corrupted} fragment(s) quarantined to {CORRUPT.name}")


def main() -> None:
    argv = sys.argv[1:]
    if not argv:
        die("usage: add|list|count|dump|repair ...")
    cmd, rest = argv[0], argv[1:]
    args = parse_args(rest)

    if cmd == "add":
        add(args)
    elif cmd == "repair":
        repair()
    elif cmd in ("list", "count", "dump", "set-status"):
        # read paths: no lock needed (atomic replace makes reads consistent)
        rows = load()
        if cmd == "list":
            sev, cat, agent, target = (
                args.get("severity"), args.get("category"),
                args.get("agent"), args.get("target"))
            for r in rows:
                if (sev and r["severity"] != sev) or (cat and r["category"] != cat) \
                   or (agent and r["agent"] != agent) or (target and r["target"] != target):
                    continue
                print(f"{r['id']} [{r['severity']}/{r['category']}] {r['target']} :: {r['title']}")
        elif cmd == "count":
            sev = args.get("severity")
            n = sum(1 for r in rows if not sev or r["severity"] == sev)
            print(f"{n} finding(s){f' at {sev}' if sev else ''}")
        elif cmd == "set-status":
            try:
                fid, status = args["_positional"][0], args["_positional"][1]
            except (IndexError, KeyError):
                die("usage: set-status <id> <open|confirmed|fixed|wonfix>")
            if status not in ("open", "confirmed", "fixed", "wonfix"):
                die(f"status must be open|confirmed|fixed|wonfix, got {status}")
            fd = lock_findings()
            rows = load()
            hit = False
            for r in rows:
                if r["id"] == fid:
                    r["status"] = status
                    hit = True
            if not hit:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except OSError:
                    pass
                die(f"no finding with id {fid}", 1)
            save(rows, fd)
            print(f"audit/record.py: {fid} -> {status}")
        else:  # dump
            if args.get("format") == "md":
                print("# Audit findings\n")
                for r in rows:
                    print(f"## `{r['id']}` [{r['severity']}/{r['category']}] {r['target']} (by {r['agent']})")
                    print(f"- **{r['title']}**")
                    print(f"- evidence: `{r['evidence']}`")
                    print(f"- impact: {r['impact']}")
                    if r.get("recommendation"):
                        print(f"- recommend: {r['recommendation']}")
                    print()
            else:
                for r in rows:
                    print(json.dumps(r))
    else:
        die(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
