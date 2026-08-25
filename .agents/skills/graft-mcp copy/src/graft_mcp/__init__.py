"""Graft kernel integration for Prime Agent (see the `graft` markdown skill for full CLI guidance).

Two surfaces beyond the CLI:

1. CLI passthrough (recommended for prose queries):

       await graft_mcp.run("ask", "how is auth handled?", "--source")
       await graft_mcp.run("map")
       await graft_mcp.run("callers", "getDb", "--depth", "2")
       await graft_mcp.run("skeleton", "electron/services/db.service.ts")

2. MCP tools over `graft mcp` (stdio), auto-discovered and bound:

       await graft_mcp.mcp.graft_find_code(query="how is auth handled?")
       await graft_mcp.mcp.graft_trace_calls(symbol="getDb", direction="in", depth=2)
       await graft_mcp.mcp.graft_find_all(pattern="resolveSecret")
       await graft_mcp.mcp.graft_file_api(file="electron/services/db.service.ts")
       await graft_mcp.mcp.graft_repo_map()
       await graft_mcp.mcp.graft_check_freshness()

Graft queries auto-refresh the graph ($0, no LLM), so no manual `graft build`
is needed after edits; `graft build --deep` (LLM concept layer) needs GRAFT_API_KEY.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import AsyncExitStack
from pathlib import Path

from rlm.mcp_base import McpIntegration

__all__ = ["run", "mcp", "GraftIntegration"]


def _repo_root(start: str | None = None) -> str:
    """Nearest ancestor of ``start`` containing a `.git` or `graft/` dir."""
    cur = Path(start or os.getcwd()).resolve()
    for d in [cur, *cur.parents]:
        if (d / ".git").exists() or (d / "graft").exists():
            return str(d)
    return str(cur)


async def run(command: str, *args: str, cwd: str | None = None) -> str:
    """Run a graft CLI command in the repo root and return its stdout.

    Args:
        command: graft subcommand (ask, map, callers, skeleton, grep, check, build, viz...).
        *args: extra CLI arguments (e.g. the query text, symbol, or file path).
        cwd: repo root override; defaults to the nearest ancestor with `.git`/`graft/`.

    Raises:
        RuntimeError: graft exited non-zero (stdout/stderr included in the message).
    """
    proc = await asyncio.create_subprocess_exec(
        "graft",
        command,
        *args,
        cwd=cwd or _repo_root(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    text = out.decode("utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"graft {command} failed ({proc.returncode}):\n{text}")
    return text


class GraftIntegration(McpIntegration):
    """MCP client for the local `graft mcp` stdio server.

    Tools are discovered from the server and bound as async methods on the
    ``mcp`` instance, e.g. ``await graft_mcp.mcp.graft_find_code(query=...)``.
    Each call opens a fresh session (kernel snapshot/restore cannot hold
    sessions), so a little latency is expected on first use.
    """

    server = "graft"

    async def _open_session(self, stack: AsyncExitStack):
        from mcp import ClientSession
        from mcp.client.stdio import stdio_client
        try:
            from mcp import StdioServerParameters
        except ImportError:  # older SDK layout
            from mcp.client.stdio import StdioServerParameters

        params = StdioServerParameters(
            command="graft",
            args=["mcp"],
            cwd=_repo_root(),
        )
        streams = await stack.enter_async_context(stdio_client(params))
        if isinstance(streams, tuple) and len(streams) == 3:
            read, write, _ = streams  # older SDK also yields a stderr stream
        else:
            read, write = streams
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        return session


#: Module-level singleton; use ``graft_mcp.mcp`` directly.
mcp = GraftIntegration()
