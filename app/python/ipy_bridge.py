#!/usr/bin/env python3
"""JSON-lines stdio bridge for the sea-agent ipy_run tool.

Protocol (one JSON object per line, UTF-8):
  request : {"id": <int>, "op": "run",    "code": "<python source>"}
            {"id": <int>, "op": "ping"}

Programmatic tool calling (plan 4.6): submitted code can call host tools as
`tools.read_file(path="x")`. That writes an out-of-band line UP the same pipe
  {"op": "tool_call", "name": "<tool>", "args": {...}}
and blocks on the host's reply
  {"op": "tool_result", "ok": true, "result": <json>}   (or ok:false + error)

`tools.parallel([...])` sends the whole batch at once instead
  {"op": "tool_calls", "calls": [{"name": .., "args": {..}}, ...]}
  {"op": "tool_result", "ok": true, "results": [{"ok": .., "result"|"error"}, ..]}
turning N sequential round trips into one. Results keep the order they were
sent in, and a failed call is a ToolError IN the list rather than an exception,
so one bad element does not lose the rest of the batch.

Two things make that safe: the request is written to the stdout buffer captured
BEFORE contextlib.redirect_stdout, so it is not swallowed by the cell's output
capture; and the reply is read from the same stdin object the main loop uses,
which is idle because it is blocked inside this very call.
  response: {"id": <int>, "ok": true,  "result": "<repr of last expr>",
             "output": "<captured stdout+stderr>"}
            {"id": <int>, "ok": false, "error": "<traceback text>",
             "output": "<captured stdout+stderr produced before failure>"}

The kernel namespace persists for the lifetime of this process, so variables,
imports and definitions survive across calls - exactly like a notebook kernel.
Messages are handled strictly sequentially in arrival order. The process never
exits on a user-code exception; only a fatal interpreter error ends it.

Deny rules inside a cell: a run request may carry
  "guard": {"exec": bool, "read": bool, "write": bool}
saying which of the cell's own actions a deny rule in permissions.json could stop.
An audit hook (PEP 578) then asks the host before each of them
  {"op": "check", "tool": "bash"|"read"|"write", "input": {"command"|"path": ..}}
  {"op": "check_result", "ok": false, "reason": "..."}
and a refusal is a PermissionError in the cell. It is a filter, like the gate:
code written to get around it (ctypes, a process that outlives the cell's view)
can.
"""

import ast
import contextlib
import io
import json
import os
import sys
import threading
import traceback


class ToolError(RuntimeError):
    """A host tool refused or failed. Catchable by the submitted program."""


class ToolProxy:
    """`tools.<name>(**kwargs)` -> one host tool call, synchronously."""

    def __init__(self, stdin, stdout) -> None:
        object.__setattr__(self, "_stdin", stdin)
        object.__setattr__(self, "_stdout", stdout)

    def __getattr__(self, name: str):
        # dunder/private lookups are Python internals (repr, pickle, help),
        # never tool calls - answering them with a callable breaks introspection
        if name.startswith("_"):
            raise AttributeError(name)

        def call(**kwargs):
            reply = self._rpc({"op": "tool_call", "name": name, "args": kwargs})
            if not reply.get("ok"):
                raise ToolError(reply.get("error") or f"tool {name} failed")
            return reply.get("result")

        call.__name__ = name
        return call

    def parallel(self, calls):
        """Run many host tool calls at once; returns results in order.

        A loop of forty `tools.read_file(...)` calls costs forty sequential
        round trips to the host. This costs one, and the host runs them
        concurrently - which is the whole reason programmatic tool calling is
        cheaper than forty separate tool_use blocks.

            results = tools.parallel([("read_file", {"path": p}) for p in paths])

        Each element is the tool's result, or a ToolError IN PLACE of it: one
        unreadable file must not lose the other thirty-nine. Check with
        `isinstance(r, ToolError)`.

        `parallel` is a real method, so it wins over __getattr__ - a host tool
        actually named "parallel" would be unreachable through the proxy.
        """
        items = []
        for c in calls:
            if isinstance(c, dict):
                name, args = c.get("name"), c.get("args")
            else:
                name, args = c
            if not name:
                raise ToolError("parallel: every call needs a tool name")
            items.append({"name": str(name), "args": dict(args or {})})
        if not items:
            return []

        reply = self._rpc({"op": "tool_calls", "calls": items})
        if not reply.get("ok"):
            raise ToolError(reply.get("error") or "parallel tool call failed")
        results = reply.get("results") or []
        out = []
        for i, item in enumerate(items):
            r = results[i] if i < len(results) else None
            if not isinstance(r, dict):
                out.append(ToolError(f"no reply for {item['name']}"))
            elif r.get("ok"):
                out.append(r.get("result"))
            else:
                out.append(ToolError(r.get("error") or f"tool {item['name']} failed"))
        return out

    def _rpc(self, request):
        """One request up the pipe, one reply back. The module docstring
        explains why this stdout and this stdin are the right ones."""
        stdout = object.__getattribute__(self, "_stdout")
        stdin = object.__getattribute__(self, "_stdin")
        # One request on the pipe at a time: a guard check from another thread
        # must not read this call's reply.
        with _PIPE:
            stdout.write((json.dumps(request) + "\n").encode("utf-8"))
            stdout.flush()
            line = stdin.readline()
        if not line:
            raise ToolError("bridge closed during a tool call")
        try:
            return json.loads(line.decode("utf-8"))
        except Exception as exc:
            raise ToolError(f"unreadable reply: {exc}") from None


_PIPE = threading.RLock()

# What a cell does itself, by audit event: the argument that names the command or path.
_EXEC = {"subprocess.Popen": 1, "os.system": 0, "os.exec": 1, "os.posix_spawn": 1, "os.spawn": 2, "pty.spawn": 0}
_WRITE = {"os.remove": (0,), "os.rmdir": (0,), "os.rename": (0, 1), "os.truncate": (0,), "os.mkdir": (0,), "os.symlink": (1,), "os.link": (1,), "shutil.rmtree": (0,)}
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC


def _command(value) -> str:
    if isinstance(value, (str, bytes, os.PathLike)):
        return os.fsdecode(value)
    words = [os.fsdecode(w) if isinstance(w, (str, bytes, os.PathLike)) else str(w) for w in value]
    if sys.platform == "win32":
        import subprocess

        return subprocess.list2cmdline(words)
    import shlex

    return shlex.join(words)


def _path(value):
    if isinstance(value, int) or value is None:
        return None
    return os.path.abspath(os.fsdecode(value))


def install_guard(proxy):
    """The audit hook, and the function that arms it for one cell (None to disarm).

    Its state lives in this closure rather than in a module global a cell could
    reassign. Outside a cell (a thread the cell left running) a guarded action
    is refused: there is nobody to answer the check."""
    state = {"guard": None, "running": False}
    local = threading.local()
    seen = {}

    def ask(tool, key, value):
        cached = seen.get((tool, value))
        if cached is not None:
            return cached
        if not state["running"]:
            return "it ran after its Python cell finished, when Mnemo cannot check it against permissions.json"
        reply = proxy._rpc({"op": "check", "tool": tool, "input": {key: value}})
        reason = None if reply.get("ok") else (reply.get("reason") or "refused by permissions.json")
        seen[(tool, value)] = reason or ""
        return reason

    def hook(event, args):
        guard = state["guard"]
        if guard is None or getattr(local, "busy", False):
            return
        if event in _EXEC:
            if not guard.get("exec"):
                return
            checks = [("bash", "command", _command(args[_EXEC[event]]))]
        elif event == "open":
            path, mode, flags = (list(args) + [None, None, None])[:3]
            path = _path(path)
            if path is None:
                return
            writes = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & _WRITE_FLAGS)
            if not guard.get("write" if writes else "read"):
                return
            checks = [("write" if writes else "read", "path", path)]
        elif event in _WRITE:
            if not guard.get("write"):
                return
            checks = [("write", "path", p) for p in (_path(args[i]) for i in _WRITE[event]) if p is not None]
        else:
            return
        local.busy = True
        try:
            for tool, key, value in checks:
                reason = ask(tool, key, value)
                if reason:
                    raise PermissionError(f"Mnemo refused {value!r}: {reason}")
        finally:
            local.busy = False

    sys.addaudithook(hook)

    def arm(guard):
        seen.clear()
        state["guard"] = guard if isinstance(guard, dict) and any(guard.get(k) for k in ("exec", "read", "write")) else None
        state["running"] = True

    def disarm():
        state["running"] = False

    return arm, disarm


class SeaKernel:
    def __init__(self, stdin=None, stdout=None) -> None:
        self.globals: dict = {"__name__": "__sea_kernel__", "__builtins__": __builtins__}
        # tools are only reachable when the host wired up a pipe for them
        if stdin is not None and stdout is not None:
            self.globals["tools"] = ToolProxy(stdin, stdout)
            self.globals["ToolError"] = ToolError

    def run(self, code: str) -> dict:
        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        try:
            tree = ast.parse(code)
        except (SyntaxError, ValueError) as exc:
            error = "".join(traceback.format_exception_only(type(exc), exc)).rstrip("\n")
            if exc.text:
                error += "\n" + exc.text.rstrip("\n")
            return {"ok": False, "error": f"SyntaxError in submitted code:\n{error}", "output": ""}

        body = list(tree.body)
        last_expr = None
        if body and isinstance(body[-1], ast.Expr):
            last_expr = body[-1]
            body = body[:-1]

        module_code = compile(ast.Module(body=body, type_ignores=[]), "<sea_kernel>", "exec") if body else None
        expr_code = compile(ast.Expression(last_expr.value), "<sea_kernel>", "eval") if last_expr else None

        result_repr = None
        try:
            with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                if module_code is not None:
                    exec(module_code, self.globals)
                if expr_code is not None:
                    value = eval(expr_code, self.globals)
                    if value is not None:
                        # Keep the repr even if user code replaced __builtins__ helpers.
                        result_repr = repr(value)
        except BaseException:  # noqa: BLE001 - report everything to the caller
            error = traceback.format_exc().rstrip("\n")
            output = stdout_buf.getvalue() + stderr_buf.getvalue()
            return {"ok": False, "error": error, "output": output}

        output = stdout_buf.getvalue() + stderr_buf.getvalue()
        return {"ok": True, "result": result_repr, "output": output}


def handle(kernel: SeaKernel, request: dict, guard=None) -> dict:
    op = request.get("op", "run")
    response = {"id": request.get("id")}
    if op == "ping":
        response.update(ok=True, result="pong", output="")
    elif op == "reset":
        kernel.__init__()  # type: ignore[func-returns-value]  # clears namespace in place
        response.update(ok=True, result="namespace cleared", output="")
    else:
        code = request.get("code", "")
        if guard is not None:
            guard[0](request.get("guard"))
        try:
            response.update(kernel.run(code))
        finally:
            if guard is not None:
                guard[1]()
    return response


def limit_memory() -> None:
    """Cap the interpreter's address space so a runaway cell raises MemoryError
    instead of taking the machine down. MNEMO_KERNEL_MEMORY_MB, 0 for no cap.
    Linux only: macOS does not enforce RLIMIT_AS and Windows has no resource."""
    if not sys.platform.startswith("linux"):
        return
    try:
        import os
        import resource

        # A value that is not a whole number ("8g") keeps the default rather than
        # silently removing the cap; only an explicit 0 (or less) does that.
        try:
            mb = int(os.environ.get("MNEMO_KERNEL_MEMORY_MB", "8192").strip())
        except ValueError:
            mb = 8192
        if mb <= 0:
            return
        cap = mb * 1024 * 1024
        _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        if hard != resource.RLIM_INFINITY:
            cap = min(cap, hard)
        resource.setrlimit(resource.RLIMIT_AS, (cap, hard))
    except Exception:
        pass


def main() -> None:
    limit_memory()
    # Unbuffered binary wrappers so partial writes are visible immediately.
    # Captured BEFORE any redirect_stdout, which is what lets a tool_call
    # escape the cell's output capture.
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    kernel = SeaKernel(stdin, stdout)
    guard = install_guard(kernel.globals["tools"])

    # explicit readline() rather than `for line in stdin`: the tools proxy
    # reads replies from this same object mid-call, and one obvious buffer is
    # easier to reason about than an iterator's read-ahead
    while True:
        line = stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line.decode("utf-8"))
        except Exception:
            response = {"id": None, "ok": False, "error": "unparseable request line", "output": ""}
        else:
            try:
                response = handle(kernel, request, guard)
            except Exception:
                response = {
                    "id": request.get("id") if isinstance(request, dict) else None,
                    "ok": False,
                    "error": traceback.format_exc(),
                    "output": "",
                }
        stdout.write((json.dumps(response) + "\n").encode("utf-8"))
        stdout.flush()


if __name__ == "__main__":
    main()
