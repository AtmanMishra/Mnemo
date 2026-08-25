---
name: graft-mcp
description: Call the graft codebase graph from the kernel. Use when a task needs codebase understanding in this repo — locating code, tracing callers, API surfaces, blast radius, or repo orientation. `await graft_mcp.run(...)` wraps the graft CLI; `await graft_mcp.mcp.<tool>(...)` calls the graft MCP server (graft_find_code, graft_trace_calls, graft_find_all, graft_file_api, graft_repo_map, graft_check_freshness). The `graft` markdown skill has the full tool-by-tool guidance; prefer graft over raw grep/reads.
---

# graft-mcp (kernel API)

Python-backed companion to the `graft` skill: exposes the graft graph directly
in the kernel. Everything is $0 and needs no API key; queries auto-refresh the
graph first, so results always match the current working tree.

## CLI passthrough

```python
await graft_mcp.run("ask", "how is auth handled?", "--source")
await graft_mcp.run("map")
await graft_mcp.run("callers", "getDb", "--depth", "2")
await graft_mcp.run("skeleton", "electron/services/db.service.ts")
await graft_mcp.run("grep", "resolveSecret")
```

`run(command, *args, cwd=None)` resolves the repo root itself (nearest ancestor
with `graft/`), so it works from any subdirectory. Raises `RuntimeError` on a
non-zero graft exit.

## MCP tools (`graft mcp` over stdio)

```python
await graft_mcp.mcp.graft_find_code(query="...", limit=5, full=False, in=None)  # ranked hits, crux inlined
await graft_mcp.mcp.graft_trace_calls(symbol="...", direction="in", depth=1)     # callers/callees, transitive
await graft_mcp.mcp.graft_find_all(pattern="...", in=None, ignore_case=False, fixed=False)  # exhaustive regex
await graft_mcp.mcp.graft_file_api(file="electron/services/db.service.ts")       # signatures of one file
await graft_mcp.mcp.graft_repo_map(max_dirs=16)                                   # orientation
await graft_mcp.mcp.graft_check_freshness()                                       # drift report
```

Each call opens a fresh session (small latency on first use). Argument names
follow the graft MCP schemas exactly.

## Policy

- Prefer graft over raw `grep -rn` / whole-file reads: it returns ranked hits
  with exact `file:line` and inlined crux.
- No manual `graft build` after edits — queries refresh themselves. `--deep`
  (LLM concept layer) is not built and needs `GRAFT_API_KEY`; don't attempt it.
- Report the `[graft] tokens saved` totals from your graft calls at the end of
  the turn (see the `graft` skill).
